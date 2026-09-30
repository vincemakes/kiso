/**
 * Modes — /mode switching, plan-mode read-only enforcement, the status
 * bar indicator, and the decidedBy audit, through the CLI's topmost
 * entry on a REAL PTY (24×80):
 *
 *  1. `--mode plan`: reads auto-allowed, the write DENIED with the
 *     guiding reason, decidedBy: "mode:plan" lands in the session log;
 *     the status bar names the mode.
 *  2. `/mode default`: the notice cell leaves the audit line; the next
 *     write is ASKED of the human again — with the v2e mini-diff — and
 *     the human decision is decidedBy-free (a human, not a policy).
 *  3. `--mode bypass` still loses to a user extension's deny (the
 *     chain's deny>ask>allow monotonicity — decidedBy names the
 *     extension, not the mode).
 *  4. KISO_MODE=plan in a PIPE: same enforcement, byte-plain (no ANSI),
 *     no human pause (the automated denial is fully deterministic).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli, stripANSI } from "../../../tests/helpers/isolated-cli.mjs";
import { SessionStore } from "@vincemakes/kiso-runtime";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** The ORDERED PTY driver: feeds[i] is written only after feeds[i-1]'s
 *  needle matched, and each feed is consumed exactly once — the "you> "
 *  prompt appears twice, and the order must be respected. */
const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, env, feeds, workdir, timeout, mode_flag, env_mode, session):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        if env_mode:
            os.environ["KISO_MODE"] = env_mode
        os.chdir(workdir)
        argv = ["node", cli]
        if mode_flag:
            argv += ["--mode", mode_flag]
        argv += ["chat", session]
        os.execvp("node", argv)
    def winsize(rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    winsize(24, 80)
    full = b""
    idx = 0
    end = time.time() + timeout
    done = False
    while time.time() < end and not done:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                done = True
                break
            full += data
            # The while (not if): several needles can sit in the SAME
            # data batch (e.g. "[Permission denied]" and "plan turn done"
            # on one line) — an if would consume one per read and stall
            # forever once the child stops emitting.
            while idx < len(feeds) and feeds[idx][0].encode() in full:
                os.write(fd, feeds[idx][1].encode())
                idx += 1
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    sys.stdout.write(full.decode(errors="replace"))
    sys.exit(0)
`;

function ptyRun(
	env: NodeJS.ProcessEnv,
	feeds: [string, string][],
	workdir: string,
	options: { modeFlag?: string; envMode?: string; session?: string; timeout?: number } = {},
): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-modes-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	// JSON.stringify(null) would emit the bare word `null` into the python
	// source — the None sentinel keeps the optional args optional.
	const py = (v: string | null | undefined): string => (v === null || v === undefined ? "None" : JSON.stringify(v));
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${JSON.stringify(workdir)}, ${options.timeout ?? 40}, ${py(options.modeFlag)}, ${py(options.envMode)}, ${py(options.session ?? "modes")})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
}

function decidedEvents(env: NodeJS.ProcessEnv, id: string) {
	const store = new SessionStore(join(env.KISO_HOME!, "sessions"));
	return store
		.load(id)
		.map((r) => r.event)
		.filter((e): e is import("@vincemakes/kiso-core").Event & { type: "permission_decided" } => e.type === "permission_decided");
}

describe("Modes (real PTY, 24×80) — plan mode, /mode switching, the audit trail", () => {
	it("--mode plan denies every write (decidedBy: mode:plan); /mode default restores the human approval WITH the v2e diff", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-modes-"));
		const workdir = join(dir, "work");
		mkdirSync(workdir, { recursive: true });
		writeFileSync(join(workdir, "notes.txt"), "hello notes", "utf8");
		const script = join(dir, "faux.json");
		// t0 read (auto-allowed under plan) → t1 write (DENIED under plan)
		// → end_turn; then, AFTER /mode default, t3 write (asked, human y,
		// v2e diff) → end_turn.
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						{ type: "tool_call_end", callId: "r1", name: "read_file", input: { path: "notes.txt" } },
						{ type: "stop", reason: "tool_use" },
					],
				},
				{
					events: [
						{ type: "tool_call_end", callId: "w1", name: "write_file", input: { path: "out.txt", content: "hello", expectedRevision: "absent" } },
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "text_delta", text: "plan turn done" }, { type: "stop", reason: "end_turn" }] },
				{
					events: [
						{ type: "tool_call_end", callId: "w2", name: "write_file", input: { path: "out.txt", content: "hello", expectedRevision: "absent" } },
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "text_delta", text: "default turn done" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["▌ ", "go\r"],
				// R13: the fold is retired, so the denial is back on the
				// denied call's OWN row — the full call name, the target and
				// the reason, which is strictly more than the fold's clause.
				["write_file out.txt", ""], // the write is denied, not asked
				["plan mode: read-only", ""], // the guiding reason reaches the model
				["plan turn done", ""],
				["▸ plan (read-only) · /mode to switch", ""], // W19: the idle row names the read-only posture (the v3 idle state)
				["▌ ", "/mode default\r"],
				["mode → default", ""], // the notice cell — the switch is on the record
				["▌ ", "go\r"],
				// The diff row marks the decision moment — the human sees the
				// change BEFORE answering (the v2d redraw paints the approval
				// frame a beat after the question — never answer on the
				// question alone, or the frame is skipped by the race).
				["+ hello", "y\r"],
				["default turn done", "exit\r"],
			],
			workdir,
			{ modeFlag: "plan", session: "modes1" },
		);
		const clean = stripANSI(out);
		expect(clean).toContain("▸ plan (read-only) · /mode to switch"); // W19 re-baseline: the idle row names the posture
		// MOVED (R13): the fold is retired, so the denial is back on the
		// denied call's OWN row — which is where it was before R3i put it
		// on a fold line, and it says strictly more there: the full call
		// name, the target, and the reason. The subject is unchanged and
		// is what is asserted — WHICH call was refused, and WHY.
		expect(clean).toContain("out.txt");
		expect(clean).toContain("plan mode: read-only");
		expect(clean).toContain("mode → default");
		// MOVED (TUI2-R2pre ④, the display-verb class — DECLARED THIS ROUND):
		// the panel's rule line names the ACT. The tool is still write_file
		// on the wire, and the dock-less fallbackQuestion still says so.
		expect(clean).toContain("write needs approval"); // the switch restored the ask — the panel's rule line
		// v2e: the approval-time diff + the frozen one-line summary.
		expect(clean).toContain("+ hello"); // the diff row (new file, all +)
		expect(clean).toContain("  write"); // W3 (sanctioned): the verb strips the _file suffix — the settled row is "write" padded
		expect(clean).toContain("+1 -0"); // the frozen ± stats
		expect(clean).toContain("▸ default · /mode to switch"); // after /mode default the idle state shows the default tier

		// The audit trail: r1 + w1 decided by the plan tier (decidedBy
		// "mode:plan"); w2 by the HUMAN (no decidedBy).
		const decided = decidedEvents(env, "modes1");
		const byCall = (callId: string) => decided.find((e) => e.callId === callId);
		expect(byCall("r1")).toMatchObject({ decision: "approved", decidedBy: "mode:plan" });
		expect(byCall("w1")).toMatchObject({ decision: "denied", decidedBy: "mode:plan", reason: "plan mode: read-only" });
		expect(byCall("w2")?.decidedBy).toBeUndefined();
		expect(byCall("w2")?.decision).toBe("approved");
		// The human-approved write actually landed.
		expect(readFileSync(join(workdir, "out.txt"), "utf8")).toBe("hello");
	}, 120_000);

	it("DC-36: bare /mode PICKS — the tiers are a list you choose from, not a word you type", () => {
		// The owner's report: `/mode` printed `tiers: manual default …`
		// and stopped, so switching meant typing the answer — while bare
		// `/model` has opened a picker since TUI2-R2 ④. Five fixed tiers
		// is the least defensible place in the product to make a human
		// type: everything needed to make it a choice was already on
		// screen and only the choosing was missing.
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-modes-"));
		const workdir = join(dir, "work");
		mkdirSync(workdir, { recursive: true });
		const script = join(dir, "faux.json");
		writeFileSync(script, JSON.stringify([{ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] }]), "utf8");
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script } as NodeJS.ProcessEnv,
			[
				["▌ ", "/mode\r"],
				// the panel is up: take `full access` by its digit. The ARROWS
				// have their own case — a pty feed fires once on its needle,
				// so a burst of them cannot prove a cursor walked.
				// the needle is a NOTE, not the header: the header carries SGR
				// between its words, and a pty driver scans the raw stream
				// for a contiguous run (DC-25/DC-29, filed twice already).
				["never asks: what would ask is refused", "4\r"],
				// and QUIT. Without it the driver waits out its whole
				// timeout: `execFileSync` blocks the vitest worker for that
				// long, and enough of those starve the reporter's RPC
				// ("Timeout calling onTaskUpdate") — the same trap DC-34's
				// file hit from the other direction.
				["mode \u2192 full access", "exit\r"],
			],
			workdir,
			{ session: "pick" },
		);
		const plain = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
		// the PANEL, not a printed list
		expect(plain, "bare /mode did not open a picker").toContain("mode — current: default");
		// every tier is offered, each saying what it DOES — the notes are
		// transcribed from decide(), so a drifting description is a bug
		for (const tier of ["default", "accept edits", "plan", "full access"]) expect(plain, `${tier} is not on the panel`).toContain(tier);
		// the switch is the panel's last row, naming its state
		expect(plain, "the don't-ask row is missing").toContain("don't ask: off");
		// 0.40.0: manual is still accepted, and no longer offered.
		expect(plain, "manual is still offered").not.toContain(" manual ");
		// Astra F4: the note now qualifies itself. Assert the WHOLE of it, so a
		// truncation at this width is a failure rather than a silent loss of
		// the qualification the finding asked for — the two asking tiers the
		// picker offers, and the tier that never asks.
		expect(plain).toContain("read-only runs; the rest asks — a saved allow still allows");
		expect(plain).toContain("read-only, edits run; rest asks — a saved allow still allows");
		expect(plain).toContain("never asks: what would ask is refused and the run goes on");
		expect(plain).toContain("reads run; all else is denied — read-only, and a deny wins");
		expect(plain).toContain("runs without asking — a user deny and the floor still win");
		expect(plain).toContain("read-only"); // plan's note
		// the row a human is looking at names the arrows, not only the
		// digits — DC-30's lesson: a hint that omits the gesture is why
		// the gesture goes unused, and it is why the owner read this
		// panel as "type the answer".
		expect(plain, "the pick row does not name the arrows").toContain("↑↓ move");
		// and choosing switched it — no word was typed
		expect(plain, "the pick did not take effect").toContain("mode → full access");
	}, 120_000);

	it("DC-36: with no dock — a PIPE — /mode prints exactly what it always printed", () => {
		// the machine-readable surface. The picker is a dock affordance;
		// this round moves no bytes where there is no dock to draw on.
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-modes-"));
		const workdir = join(dir, "work");
		mkdirSync(workdir, { recursive: true });
		const script = join(dir, "faux.json");
		writeFileSync(script, JSON.stringify([{ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] }]), "utf8");
		const piped = runCli(["chat", "modepipe"], { ...env, KISO_FAUX_SCRIPT: script }, { input: "/mode\nexit\n", timeout: 60_000 });
		expect(piped.status).toBe(0);
		expect(piped.stdout).toContain("mode default");
		expect(piped.stdout).toContain("tiers: default accept-edits plan full-access");
		expect(piped.stdout, "the switch is off, so the pipe says nothing about it").not.toContain("don't ask");
		expect(piped.stdout, "a panel leaked onto a pipe").not.toContain("mode — current");
		expect(piped.stdout, "pipes are byte-plain").not.toContain("\u001b[");
	}, 120_000);

	it("--mode bypass (full-access's old name) still loses to a user extension's deny (monotonicity)", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-modes-"));
		const workdir = join(dir, "work");
		mkdirSync(workdir, { recursive: true });
		writeFileSync(
			join(dirs.extensions, "safe-test.mjs"),
			`export default {
	name: "safe-test",
	approvals: [
		{
			decide(call) {
				if (["read_file", "list_dir", "search_text"].includes(call.name)) return { action: "allow" };
				if (
					call.name === "shell" &&
					/\\bgit\\s+(stash|reset|checkout\\s+--)|rm\\s+-rf/.test(String(call.input.command ?? ""))
				) {
					return { action: "deny", reason: "destructive command — refused by safe-test" };
				}
				return { action: "ask" };
			},
		},
	],
};
`,
			"utf8",
		);
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						// 0.40.0: `git reset --hard` on the workspace is the FLOOR's now
						// (it would be decidedBy floor); `git stash` is the extension's
						// alone, which is what this monotonicity case is about.
						{ type: "tool_call_end", callId: "s1", name: "shell", input: { command: "git stash" } },
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "text_delta", text: "shell done" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["▌ ", "go\r"],
				["▸ full access", ""], // v3 idle state — the old name reads as the tier it names
				// (a "1 denied:" needle stood here: R13 retired the stretch fold
				// that printed it, and the chain waited out its 40 s timeout on
				// every run since, the assertions below passing on the tail)
				["refused by safe-test", ""], // the EXTENSION's deny — bypass can't override it
				["shell done", "exit\r"],
			],
			workdir,
			{ modeFlag: "bypass", session: "modes2" },
		);
		const clean = stripANSI(out);
		expect(clean).toContain("▸ full access · /mode to switch");
		expect(clean).toContain("[Permission denied]");
		expect(clean).toContain("refused by safe-test");
		// decidedBy names the extension, not the mode.
		const decided = decidedEvents(env, "modes2");
		expect(decided.find((e) => e.callId === "s1")).toMatchObject({
			decision: "denied",
			decidedBy: "safe-test",
			reason: "destructive command — refused by safe-test",
		});
	}, 90_000);

	it("0.40.0: a provably read-only shell call runs unasked (decidedBy: read-only-shell); any other shell call still asks", () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-modes-"));
		const workdir = join(dir, "work");
		mkdirSync(workdir, { recursive: true });
		writeFileSync(join(workdir, "notes.txt"), "alpha\nbeta\n", "utf8");
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{ events: [{ type: "tool_call_end", callId: "s1", name: "shell", input: { command: "cat notes.txt | wc -l" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "tool_call_end", callId: "s2", name: "shell", input: { command: "touch made.txt" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "text_delta", text: "ro done" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		// ONE approval is fed. If the read had asked, it would take the
		// `y`, and the write's panel would wait out the timeout unanswered.
		ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["▌ ", "go\r"],
				["don't ask again", "y\r"],
				["ro done", "exit\r"],
			],
			workdir,
			{ modeFlag: "default", session: "modes-ro" },
		);
		const events = new SessionStore(join(env.KISO_HOME!, "sessions")).load("modes-ro").map((r) => r.event);
		const asked = events.filter((e) => e.type === "permission_requested").map((e) => (e as { callId: string }).callId);
		expect(asked, "only the write was put to the human").toEqual(["s2"]);
		const decided = decidedEvents(env, "modes-ro");
		expect(decided.find((e) => e.callId === "s1")).toMatchObject({ decision: "approved", decidedBy: "read-only-shell" });
		expect(decided.find((e) => e.callId === "s2")?.decidedBy, "the human, not a policy").toBeUndefined();
		// and the read really ran
		const result = events.find((e) => e.type === "tool_result" && (e as { callId: string }).callId === "s1") as { content: string } | undefined;
		expect(result?.content).toContain("2");
	}, 90_000);

	it("0.40.0 dontAsk: what would ask is denied with one line and the run goes on; the read-only allow and a saved allow still allow", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-modes-"));
		const workdir = join(dir, "work");
		mkdirSync(workdir, { recursive: true });
		writeFileSync(join(workdir, "notes.txt"), "alpha\n", "utf8");
		// a saved allow, shaped like the generated don't-ask-again rule
		writeFileSync(
			join(dirs.extensions, "saved-allow.mjs"),
			`export default { name: "saved-allow", approvals: [{ decide(call) { return call.name === "write_file" ? { action: "allow" } : { action: "abstain" }; } }] };\n`,
			"utf8",
		);
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{ events: [{ type: "tool_call_end", callId: "s1", name: "shell", input: { command: "cat notes.txt" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "tool_call_end", callId: "s2", name: "shell", input: { command: "touch made.txt" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "tool_call_end", callId: "w1", name: "write_file", input: { path: "out.txt", content: "x", expectedRevision: "absent" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "text_delta", text: "dontask done" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		// NO approval is fed: a panel that opened would wait out the timeout.
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["▌ ", "go\r"],
				["dontask done", "exit\r"],
			],
			workdir,
			{ modeFlag: "dontAsk", session: "modes-dontask" },
		);
		const clean = stripANSI(out);
		expect(clean, "the one-line notice").toContain("[dontAsk] shell would ask — denied");
		expect(clean, "the run went on to its end").toContain("dontask done");
		const decided = decidedEvents(env, "modes-dontask");
		expect(decided.find((e) => e.callId === "s1")).toMatchObject({ decision: "approved", decidedBy: "read-only-shell" });
		expect(decided.find((e) => e.callId === "s2")).toMatchObject({ decision: "denied" });
		expect(decided.find((e) => e.callId === "s2")?.reason).toContain("dontAsk");
		expect(decided.find((e) => e.callId === "w1")).toMatchObject({ decision: "approved", decidedBy: "saved-allow" });
		expect(existsSync(join(workdir, "made.txt")), "the denied command never ran").toBe(false);
		expect(existsSync(join(workdir, "out.txt")), "the saved allow still allowed").toBe(true);
	}, 90_000);

	it("0.40.0: accept-edits still ASKS for a write into .git/ — configuration that runs", () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-modes-"));
		const workdir = join(dir, "work");
		mkdirSync(join(workdir, ".git"), { recursive: true });
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{ events: [{ type: "tool_call_end", callId: "w1", name: "write_file", input: { path: "notes.md", content: "x", expectedRevision: "absent" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "tool_call_end", callId: "w2", name: "write_file", input: { path: ".git/config", content: "[core]\n", expectedRevision: "absent" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "text_delta", text: "pw done" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		// ONE approval is fed: had the ordinary write asked, it would take it
		// and the .git write would wait out the timeout.
		ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["▌ ", "go\r"],
				["don't ask again", "y\r"],
				["pw done", "exit\r"],
			],
			workdir,
			{ modeFlag: "accept-edits", session: "modes-pw" },
		);
		const events = new SessionStore(join(env.KISO_HOME!, "sessions")).load("modes-pw").map((r) => r.event);
		const asked = events.filter((e) => e.type === "permission_requested").map((e) => (e as { callId: string }).callId);
		expect(asked, "only the .git write was put to the human").toEqual(["w2"]);
		const decided = decidedEvents(env, "modes-pw");
		expect(decided.find((e) => e.callId === "w1")).toMatchObject({ decision: "approved", decidedBy: "mode:accept-edits" });
	}, 90_000);

	it("0.40.0 dontAsk (review B5): an interrupted execution is left undecided with one line — no panel — and a turn behind it is held", () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-modes-"));
		const workdir = join(dir, "work");
		mkdirSync(workdir, { recursive: true });
		// the aborted-mid-tool shape: a closed run whose shell execution
		// started and never reported
		const sessions = join(env.KISO_HOME!, "sessions");
		mkdirSync(sessions, { recursive: true });
		const lines = [
			{ type: "user_input", content: "clean up" },
			{ type: "tool_call_end", callId: "u1", name: "shell", input: { command: "touch x" } },
			{ type: "tool_execution_started", callId: "u1", invocationSeq: 1, name: "shell", input: { command: "touch x" }, executionId: "ex-u1" },
			{ type: "terminal", outcome: { kind: "aborted", by: "user" } },
		].map((event, seq) => JSON.stringify({ runId: "runA", ts: seq, event: { ...event, seq } }));
		writeFileSync(join(sessions, "modes-unc.jsonl"), `${lines.join("\n")}\n`, "utf8");
		const script = join(dir, "faux.json");
		writeFileSync(script, JSON.stringify([{ events: [{ type: "text_delta", text: "never reached" }, { type: "stop", reason: "end_turn" }] }]), "utf8");
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["left unresolved", ""],
				["▌ ", "go\r"],
				["turn held", "exit\r"],
			],
			workdir,
			{ modeFlag: "dontAsk", session: "modes-unc" },
		);
		const clean = stripANSI(out);
		expect(clean).toContain("[dontAsk] 1 uncertain execution left unresolved — resolve them in an asking mode");
		expect(clean, "no recovery panel opened").not.toContain("rerun");
		expect(clean).toContain("turn held");
		// nothing was fabricated: no resolution was recorded
		const events = new SessionStore(sessions).load("modes-unc").map((r) => r.event.type);
		expect(events).not.toContain("tool_execution_resolved");
	}, 90_000);

	it("0.40.0 dontAsk (review B5): an untrusted project .kiso on a TTY is not loaded and not asked about, and nothing is recorded", () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-modes-"));
		const workdir = join(dir, "work");
		mkdirSync(join(workdir, ".kiso"), { recursive: true });
		writeFileSync(join(workdir, ".kiso", "config.json"), `${JSON.stringify({ contextWindow: 100000 })}\n`, "utf8");
		const script = join(dir, "faux.json");
		writeFileSync(script, JSON.stringify([{ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] }]), "utf8");
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["▌ ", "exit\r"],
			],
			workdir,
			{ modeFlag: "dontAsk", session: "modes-trust" },
		);
		const clean = stripANSI(out);
		expect(clean).toContain("[dontAsk] [project .kiso] found 1 artifact(s)");
		expect(clean, "no trust panel opened").not.toContain("trust this project's .kiso?");
		// no sticky refusal: a later asking session can still decide
		const store = join(env.KISO_HOME!, "trust.jsonl");
		expect(existsSync(store) ? readFileSync(store, "utf8") : "").not.toContain(realpathSync(workdir));
	}, 90_000);

	it("KISO_MODE=plan in a PIPE: same enforcement, byte-plain, no human pause", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-modes-"));
		const workdir = join(dir, "work");
		mkdirSync(workdir, { recursive: true });
		writeFileSync(join(workdir, "notes.txt"), "hi", "utf8");
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						{ type: "tool_call_end", callId: "p1", name: "write_file", input: { path: "out.txt", content: "x", expectedRevision: "absent" } },
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "text_delta", text: "pipe done" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const run = runCli(["chat", "modes3"], { ...env, KISO_MODE: "plan", KISO_FAUX_SCRIPT: script }, {
			input: "go\nexit\n",
			timeout: 60_000,
		});
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("[Permission denied]");
		expect(run.stdout).toContain("plan mode: read-only");
		expect(run.stdout).toContain("pipe done");
		expect(run.stdout).not.toContain("\u001b["); // pipes are byte-plain — no ANSI
		const decided = decidedEvents({ ...env }, "modes3");
		expect(decided.find((e) => e.callId === "p1")).toMatchObject({
			decision: "denied",
			decidedBy: "mode:plan",
			reason: "plan mode: read-only",
		});
	}, 90_000);
});

describe("the don't-ask switch (real PTY, 24×80) — a second question beside the tier", () => {
	it("full access with don't ask: a write runs unasked, ask_user is not offered, the floor still refuses, and the status row says both", () => {
		const { env } = isolatedEnv();
		const base = realpathSync(mkdtempSync(join(tmpdir(), "kiso-modes-")));
		const workdir = join(base, "work");
		mkdirSync(workdir, { recursive: true });
		writeFileSync(join(workdir, "sentinel.txt"), "still here", "utf8");
		const script = join(base, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{ events: [{ type: "tool_call_end", callId: "s1", name: "shell", input: { command: "touch made.txt" } }, { type: "stop", reason: "tool_use" }] },
				{
					events: [
						{ type: "tool_call_end", callId: "q1", name: "ask_user", input: { questions: [{ question: "which bundler?", options: [{ label: "vite" }, { label: "esbuild" }] }] } },
						{ type: "stop", reason: "tool_use" },
					],
				},
				// the workspace root by its absolute path — the floor's, in every
				// tier and with the switch on too
				{ events: [{ type: "tool_call_end", callId: "f1", name: "shell", input: { command: `rm -rf ${workdir}` } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "text_delta", text: "fa done" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		// NO answer is fed: a panel that opened would wait out the timeout.
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script, KISO_DONT_ASK: "1" },
			[
				["▌ ", "go\r"],
				["fa done", "exit\r"],
			],
			workdir,
			{ modeFlag: "full-access", session: "modes-fa" },
		);
		const clean = stripANSI(out);
		expect(clean).toContain("▸ full access · don't ask · /mode to switch");
		expect(clean, "the run went on to its end").toContain("fa done");
		const events = new SessionStore(join(env.KISO_HOME!, "sessions")).load("modes-fa").map((r) => r.event);
		expect(events.filter((e) => e.type === "permission_requested"), "nothing was put to a person").toEqual([]);
		const decided = decidedEvents(env, "modes-fa");
		expect(decided.find((e) => e.callId === "s1")).toMatchObject({ decision: "approved", decidedBy: "mode:full-access" });
		expect(existsSync(join(workdir, "made.txt")), "the write ran").toBe(true);
		// ask_user was not in the table: the kernel refused an unknown tool
		const q1 = events.find((e) => e.type === "tool_result" && (e as { callId: string }).callId === "q1") as { content: string } | undefined;
		expect(String(q1?.content)).toBe("Unknown tool: ask_user");
		// don't ask grants nothing: the floor's deny stands
		expect(decided.find((e) => e.callId === "f1")).toMatchObject({ decision: "denied", decidedBy: "floor" });
		expect(existsSync(join(workdir, "sentinel.txt")), "the refused command never ran").toBe(true);
	}, 90_000);

	it("the /mode panel's last row flips the switch and leaves the tier", () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-modes-"));
		const workdir = join(dir, "work");
		mkdirSync(workdir, { recursive: true });
		const script = join(dir, "faux.json");
		writeFileSync(script, JSON.stringify([{ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] }]), "utf8");
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script } as NodeJS.ProcessEnv,
			[
				["▌ ", "/mode\r"],
				["never asks: what would ask is refused", "5\r"],
				["don't ask \u2192 on", "exit\r"],
			],
			workdir,
			{ modeFlag: "plan", session: "pick-switch" },
		);
		const plain = stripANSI(out);
		expect(plain).toContain("don't ask → on");
		expect(plain, "the tier moved").not.toContain("mode → ");
		expect(plain).toContain("▸ plan (read-only) · don't ask");
	}, 120_000);

	it("the old name: a switch that came with dontAsk leaves with it on shift+tab — and says so", () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-modes-"));
		const workdir = join(dir, "work");
		mkdirSync(workdir, { recursive: true });
		const script = join(dir, "faux.json");
		writeFileSync(script, JSON.stringify([{ events: [{ type: "text_delta", text: "What would you like me to inspect?" }, { type: "stop", reason: "end_turn" }] }]), "utf8");
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script } as NodeJS.ProcessEnv,
			[
				// the settled first turn is the REPL-ready anchor (R3a)
				["▌ ", "hi\r"],
				["What would you like me to inspect", "\x1b[Z"],
				["don't ask \u2192 off", "exit\r"],
			],
			workdir,
			{ envMode: "dontAsk", session: "old-name-leaves" },
		);
		const plain = stripANSI(out);
		expect(plain).toContain("▸ default · don't ask");
		expect(plain).toContain("mode → accept edits (shift+tab cycles)");
		expect(plain).toContain("don't ask → off");
	}, 120_000);
});
