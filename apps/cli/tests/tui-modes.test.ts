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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
				// R3i phase 3: the denied write's own row is absorbed by the
				// stretch fold, which NAMES the denial instead — so the
				// needle is the clause, which is what a human now reads.
				["1 denied:", ""], // the write is denied, not asked
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
		// R3i phase 3: the denied write's own row is absorbed by the
		// stretch fold, and the fold NAMES the denial — which call, and
		// why — so the screen carries strictly more than the bare
		// `[Permission denied]` row it replaces. The durable log and the
		// pipe path still carry the raw text verbatim; that is asserted
		// against `run.stdout` in tui-v7-planmode, and unaffected here.
		expect(clean).toContain("1 denied: out.txt (plan mode: read-only)");
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
				// the panel is up: take `bypass` by its digit. The ARROWS
				// have their own case — a pty feed fires once on its needle,
				// so a burst of them cannot prove a cursor walked.
				// the needle is a NOTE, not the header: the header carries SGR
				// between its words, and a pty driver scans the raw stream
				// for a contiguous run (DC-25/DC-29, filed twice already).
				["every tool asks", "5\r"],
				// and QUIT. Without it the driver waits out its whole
				// timeout: `execFileSync` blocks the vitest worker for that
				// long, and enough of those starve the reporter's RPC
				// ("Timeout calling onTaskUpdate") — the same trap DC-34's
				// file hit from the other direction.
				["mode \u2192 bypass", "exit\r"],
			],
			workdir,
			{ session: "pick" },
		);
		const plain = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
		// the PANEL, not a printed list
		expect(plain, "bare /mode did not open a picker").toContain("mode — current: default");
		// every tier is offered, each saying what it DOES — the notes are
		// transcribed from decide(), so a drifting description is a bug
		for (const tier of ["manual", "default", "accept-edits", "plan", "bypass"]) expect(plain, `${tier} is not on the panel`).toContain(tier);
		expect(plain).toContain("every tool asks"); // manual's note
		expect(plain).toContain("read-only"); // plan's note
		// the row a human is looking at names the arrows, not only the
		// digits — DC-30's lesson: a hint that omits the gesture is why
		// the gesture goes unused, and it is why the owner read this
		// panel as "type the answer".
		expect(plain, "the pick row does not name the arrows").toContain("↑↓ move");
		// and choosing switched it — no word was typed
		expect(plain, "the pick did not take effect").toContain("mode → bypass");
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
		expect(piped.stdout).toContain("tiers: manual default accept-edits plan bypass");
		expect(piped.stdout, "a panel leaked onto a pipe").not.toContain("mode — current");
		expect(piped.stdout, "pipes are byte-plain").not.toContain("\u001b[");
	}, 120_000);

	it("--mode bypass still loses to a user extension's deny (monotonicity)", () => {
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
						{ type: "tool_call_end", callId: "s1", name: "shell", input: { command: "git reset --hard" } },
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
				["▸ bypass", ""], // v3 idle state under bypass
				// R3i phase 3: the denial is named on the stretch fold now.
				["1 denied:", ""],
				["refused by safe-test", ""], // the EXTENSION's deny — bypass can't override it
				["shell done", "exit\r"],
			],
			workdir,
			{ modeFlag: "bypass", session: "modes2" },
		);
		const clean = stripANSI(out);
		expect(clean).toContain("▸ bypass · /mode to switch");
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
