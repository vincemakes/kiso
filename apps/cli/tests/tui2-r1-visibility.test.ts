/**
 * TUI2-R1 — the round's product-surface gates on real CLI processes.
 *
 * T-V2 (B) here is the half a compositor unit cannot prove: that the
 * exploration rollup is a DISPLAY-SIDE PROJECTION. The durable event log
 * of a session whose burst rolled up must be byte-for-byte the log of
 * the same burst that did not — the rows collapsed, nothing else did —
 * and the PIPE, which has no compositor at all, must never grow the row.
 *
 * T-V5 (E) is here too: /context reads the session's TRACE SIDECAR, the
 * observation file E1/E3 already write, and renders the last request's
 * rent parts. A session with no sidecar renders an honest fallback.
 */

/**
 * DECLARED SUPERSESSION (R3g, 2026-08-28) — the fold's terms are
 * VERB + COUNT + NOUN now ("read 5 files"), where they used to be a
 * bare count and a noun borrowed from the rollup table ("5 reads",
 * "1 match"). That table names what a single-tool rollup COUNTS —
 * "14 matches" means fourteen matched lines — while this line counts
 * CALLS, so one search rendered "1 match" whenever the search matched
 * any other number. The phrasing is the owner's.
 */
/**
 * DECLARED SUPERSESSION (R3h, 2026-08-29) — `thought 0s` IS DROPPED, so
 * the fold's lead term is OPTIONAL in these patterns. R3b ruled that a
 * zero term is a sentence about something that did not happen; the
 * thought term was exempt by accident (written before the rule). The
 * faux model emits no thinking, so every fold here led with `thought
 * 0s` — which is exactly the sentence the rule forbids.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shellProgressPath } from "@vincemakes/kiso-tools-node";
import { isolatedEnv, runCli, stripANSI } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** The durable session log lines (run envelope + event). */
function logLines(home: string, sid: string): { event: Record<string, unknown> }[] {
	const p = join(home, "sessions", `${sid}.jsonl`);
	expect(existsSync(p), `session log missing: ${p}`).toBe(true);
	return readFileSync(p, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as { event: Record<string, unknown> });
}

function fauxScript(turns: unknown[]): string {
	const p = join(mkdtempSync(join(tmpdir(), "kiso-faux-")), "faux.json");
	writeFileSync(p, JSON.stringify(turns), "utf8");
	return p;
}

/** A read-only burst: 3 reads, 2 searches, 1 list — one turn, then text. */
function exploreTurns(): unknown[] {
	const events: unknown[] = [];
	for (let i = 0; i < 3; i += 1) {
		events.push({ type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.txt` } });
	}
	for (let i = 0; i < 2; i += 1) {
		events.push({ type: "tool_call_end", callId: `s${i}`, name: "search_text", input: { pattern: "alpha", path: "." } });
	}
	events.push({ type: "tool_call_end", callId: "l0", name: "list_dir", input: { path: "." } });
	events.push({ type: "stop", reason: "tool_use" });
	return [{ events }, { events: [{ type: "text_delta", text: "explored." }, { type: "stop", reason: "end_turn" }] }];
}

const PTY_DRIVER = `
import pty, os, sys, time, select, struct, fcntl, termios, signal

def driver(cli, args, env, feeds, timeout, cwd):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        if cwd:
            os.chdir(cwd)
        os.execvp("node", ["node", cli] + args)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
    full = b""
    fed = set()
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
            for i, (needle, text) in enumerate(feeds):
                if i not in fed and needle.encode() in full:
                    os.write(fd, text.encode())
                    fed.add(i)
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

function ptyRun(args: string[], env: NodeJS.ProcessEnv, feeds: [string, string][], timeout = 40, cwd?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-r1-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(args)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${timeout}, ${cwd === undefined ? "None" : JSON.stringify(cwd)})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 120_000, env: process.env });
}

/** A workspace with the files the burst reads. */
function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-ws-"));
	for (let i = 0; i < 3; i += 1) writeFileSync(join(dir, `f${i}.txt`), `alpha ${i}\nbeta ${i}\n`, "utf8");
	return dir;
}

describe("TUI2-R1 T-V2 — the exploration rollup is display-side (real CLI)", () => {
	it("the PTY shows ONE exploration row; the PIPE never does; both durable logs carry every call in full", () => {
		const ws = workspace();
		const script = fauxScript(exploreTurns());

		// the PTY leg — the compositor is up, the burst collapses
		const pty = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" });
		const out = stripANSI(ptyRun(["--mode", "bypass", "r1-pty"], pty.env as NodeJS.ProcessEnv, [["▌ ", "go\r"], ["explored.", "exit\r"]], 40, ws));
		// R3b (owner ruling): the burst's SETTLED form is the segment fold;
		// the exploration row is what `ctrl+r` opens. This case's subject —
		// the PTY collapses and the PIPE never does — is unchanged, and the
		// pipe leg below still proves the durable record is identical.
		expect(out).toMatch(/✦ (thought \d+s · )?read 3 files · ran 2 searches · listed 1 directory/);
		// R4a: the fold row prints no key — the row above IS the settled
		// form, and what `ctrl+r` opens is pinned in the unit suite.

		// the PIPE leg — no compositor, no row, byte-for-byte the line mode
		const pipe = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" });
		const res = runCli(["--mode", "bypass", "r1-pipe"], pipe.env as NodeJS.ProcessEnv, { input: "go\nexit\n", cwd: ws });
		expect(res.status, res.stderr).toBe(0);
		expect(res.stdout).not.toContain("explored 3 files");
		// R3d: the pipe HAS a recap (it is a local line, zero tokens) and the
		// recap now opens `✦ thought` too — so the needle that proved "no
		// fold here" would now fire on the recap. What the pipe must not
		// have is the fold's own affordance: nothing is collapsed, so
		// nothing offers to expand.
		expect(res.stdout).not.toContain("ctrl+r");
		expect(res.stdout).not.toContain("ctrl+r");
		// the pipe's own per-call rows are intact — all six, one each
		expect(res.stdout.match(/\u2713 read /g) ?? []).toHaveLength(3); // R2: the pipe keeps its mark
		expect(res.stdout.match(/\u2713 search_text /g) ?? []).toHaveLength(2);
		expect(res.stdout.match(/\u2713 list_dir /g) ?? []).toHaveLength(1);

		// THE DURABLE LOGS: the rolled session's events are the unrolled
		// session's events — same types, same order, same contents. The
		// only fields allowed to differ are the per-session identities.
		const shape = (home: string, sid: string): string =>
			JSON.stringify(
				logLines(home, sid)
					.map((l) => l.event)
					.filter((e) => String(e.type).startsWith("tool_"))
					.map((e) => ({ type: e.type, name: e.name, callId: e.callId, content: e.content, isError: e.isError })),
			);
		const rolled = shape(pty.env.KISO_HOME as string, "r1-pty");
		const flat = shape(pipe.env.KISO_HOME as string, "r1-pipe");
		expect(rolled).toBe(flat);
		// and the content really is there in full (not an empty-equals-empty)
		expect(rolled).toContain("alpha 0");
	}, 180_000);
});

describe("TUI2-R1 T-V3 — the live tail on a real PTY", () => {
	it("a long shell shows its output WHILE it runs, the tail moves, and the completed cell is one line again", () => {
		const ws = workspace();
		// a SHORT command string on purpose: the settled head row must have
		// room for A's suffix, and a 60-char command would spend it all.
		writeFileSync(join(ws, "steps.sh"), "for i in 1 2 3 4 5 6; do echo \"step $i of six\"; sleep 0.35; done\n", "utf8");
		const command = "sh steps.sh";
		const script = fauxScript([
			{ events: [{ type: "tool_call_end", callId: "c1", name: "shell", input: { command } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "ran it." }, { type: "stop", reason: "end_turn" }] },
		]);
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" });
		const out = stripANSI(ptyRun(["--mode", "bypass", "r1-tail"], env as NodeJS.ProcessEnv, [["▌ ", "go\r"], ["ran it.", "exit\r"]], 60, ws));

		// THE TAIL WAS LIVE: the footer appeared while the command ran…
		expect(out).toContain("live tail · esc stop · alt+⏎ redirect");
		// …and it MOVED — early steps and late steps were both on screen
		// inside the running block (the sidecar was re-read, not read once)
		expect(out).toContain("│ step 1 of six");
		expect(out).toContain("│ step 6 of six");

		// COMPLETION collapses: the settled row is one line with A's
		// suffix, and the live-tail footer is not part of it.
		// MOVED (R1.5 slice 5, the approval-attribution class — DECLARED
		// THIS ROUND): a POLICY verdict is ambient and silent; a HUMAN
		// verdict is what the row records. `approved by mode:*` was the
		// runtime's backfill for "no policy expressed an opinion", read by
		// a human as an attribution (VD-11).
		expect(out).toContain("  shell sh steps.sh (exit 0, ");
		expect(out).toContain(") · 6 lines · ctrl+r expands");
		const settledAt = out.lastIndexOf("  shell");
		expect(settledAt).toBeGreaterThan(0);
		expect(out.slice(settledAt)).not.toContain("live tail");

		// THE SIDECAR IS NOT DURABLE STATE: it was removed at settle, and
		// it never lived under KISO_HOME in the first place — recovery
		// reads the event log, and the log is complete.
		expect(existsSync(shellProgressPath("r1-tail", command))).toBe(false);
		const events = logLines(env.KISO_HOME as string, "r1-tail").map((l) => l.event);
		const result = events.find((e) => e.type === "tool_result");
		expect(String(result?.content)).toContain("step 6 of six");
	}, 180_000);

	it("a GHOST sidecar left by a killed run is never shown — the freshness guard", () => {
		// a leftover file with an old mtime, exactly where a kill -9 would
		// have left one, for the command the next run is about to make
		const ws = workspace();
		const command = "echo done";
		const ghost = shellProgressPath("r1-ghost", command);
		mkdirSync(dirname(ghost), { recursive: true });
		writeFileSync(ghost, "GHOST OUTPUT FROM A KILLED RUN\n", "utf8");
		utimesSync(ghost, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
		const script = fauxScript([
			{ events: [{ type: "tool_call_end", callId: "c1", name: "shell", input: { command } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "ran it." }, { type: "stop", reason: "end_turn" }] },
		]);
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" });
		const out = stripANSI(ptyRun(["--mode", "bypass", "r1-ghost"], env as NodeJS.ProcessEnv, [["▌ ", "go\r"], ["ran it.", "exit\r"]], 40, ws));
		expect(out).not.toContain("GHOST OUTPUT");
		expect(out).toContain("ran it."); // the run itself was untouched
	}, 180_000);
});

describe("TUI2-R1 T-V4 — the ? keys sheet on a real PTY", () => {
	it("? paints the sheet, the next key takes it away, and nothing of it reaches the composer", () => {
		const ws = workspace();
		const script = fauxScript([{ events: [{ type: "text_delta", text: "hello there." }, { type: "stop", reason: "end_turn" }] }]);
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" });
		const out = stripANSI(
			ptyRun(
				["--mode", "bypass", "r1-sheet"],
				env as NodeJS.ProcessEnv,
				[
					["▌ ", "hi\r"], // a normal turn first — the composer works
					["hello there.", "?"], // the REAL key, on an empty composer
					["expand cells", "x"], // any key closes it
				],
				// the driver stops the process itself: `exit` typed while the
				// sheet is up would be EATEN by the close (any key closes,
				// and the whole chunk goes with it), which is the contract —
				// so the transcript, not a clean exit, is the evidence here.
				12,
				ws,
			),
		);
		// the sheet was on screen, in full
		expect(out).toContain("enter send");
		expect(out).toContain("ctrl+r expand cells");
		// MOVED (R1.5 pin 6, the wrap/copy class): see the tui-cells unit.
		// DECLARED SUPERSESSION (R6/D2): the row claims only what is true
		// of EVERY panel now. `1-4 instant` was false on the ask's
		// multi-select and on the pick panel, `or click` was false on
		// both, and "1-4" was wrong for any panel with a different option
		// count — while the row's own comment said it was true of every
		// flavor. Each panel's own affordance row states its whole truth.
		expect(out).toContain("panels: ↑↓ move · ⏎ confirms · digits act on their row · t types");
		// the `?` never became text, and neither did the key that closed it.
		// R2: the composer has no wall and no prompt glyph, so the needle
		// is the row's erase-to-end immediately followed by the character —
		// which is what a `?` typed into the composer would look like.
		expect(out).not.toContain("\x1b[0K?");
		expect(out).not.toContain("\x1b[0Kx");
		// the session carried on normally afterwards
		expect(out).toContain("hello there.");
		const events = logLines(env.KISO_HOME as string, "r1-sheet").map((l) => l.event);
		const user = events.filter((e) => e.type === "user_input").map((e) => String(e.content));
		expect(user).toEqual(["hi"]); // never "?" and never "x"
	}, 180_000);
});

describe("TUI2-R1 T-V5 — /context reads the REAL trace sidecar", () => {
	it("a session that has run a turn renders the rent attribution; the parts sum to the header", () => {
		const ws = workspace();
		const script = fauxScript([{ events: [{ type: "text_delta", text: "answered." }, { type: "stop", reason: "end_turn" }] }]);
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" });
		const res = runCli(["--mode", "bypass", "r1-ctx"], env as NodeJS.ProcessEnv, { input: "hello\n/context\nexit\n", cwd: ws });
		expect(res.status, res.stderr).toBe(0);
		const out = stripANSI(res.stdout);

		// the sidecar the rows were read FROM really exists and really has
		// a rent block — the rows are not a fabrication of the renderer
		const trace = join(env.KISO_HOME as string, "sessions", "traces", "r1-ctx.jsonl");
		expect(existsSync(trace)).toBe(true);
		const requests = readFileSync(trace, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as { kind: string; rent?: { surface: string; estTokens: number }[] })
			.filter((r) => r.kind === "request");
		expect(requests.length).toBeGreaterThan(0);
		const rent = requests[requests.length - 1]!.rent ?? [];
		expect(rent.some((l) => l.surface === "system:base")).toBe(true);
		expect(rent.some((l) => l.surface.startsWith("tool:"))).toBe(true);

		// the rendered rows
		expect(out).toContain("context — ");
		expect(out).toContain("system prompt");
		expect(out).toContain("tool table");
		expect(out).toContain("envelope");
		expect(out).toContain("free");
		// the tool count matches the ledger's own tool: lines, exactly
		const tools = rent.filter((l) => l.surface.startsWith("tool:")).length;
		expect(out).toContain(`${tools} tools`);
	}, 120_000);

	it("a session with NO sidecar renders the honest fallback — never a crash, never an empty bar", () => {
		const ws = workspace();
		const { env } = isolatedEnv({ KISO_MODE: "bypass" });
		// /context BEFORE any turn: no request has happened, so no ledger
		const res = runCli(["--mode", "bypass", "r1-noctx"], env as NodeJS.ProcessEnv, { input: "/context\nexit\n", cwd: ws });
		expect(res.status, res.stderr).toBe(0);
		const out = stripANSI(res.stdout);
		expect(out).toContain("context — no ledger yet");
		expect(out).toContain("the ledger is written per request");
		expect(out).not.toContain("▰");
		expect(out).not.toContain("▱");
	}, 120_000);

	it("the status row shows NO $ on a route with no rate — the omission is the feature", () => {
		const ws = workspace();
		const script = fauxScript([{ events: [{ type: "text_delta", text: "answered." }, { type: "stop", reason: "end_turn" }] }]);
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" });
		const out = stripANSI(
			ptyRun(["--mode", "bypass", "r1-meter"], env as NodeJS.ProcessEnv, [["▌ ", "hi\r"], ["answered.", "exit\r"]], 25, ws),
		);
		// the idle row painted, and it carries no invented price
		expect(out).toContain("▸ bypass · /mode to switch · faux · ctx left ~");
		expect(out).not.toMatch(/\$\d/);
	}, 120_000);

	it("THE PURITY GATE IS UNTOUCHED — /context is a display path, and the derivation still reads nothing", () => {
		// The reader lives in the CLI's state.ts and returns rows; nothing
		// it produces reaches a recovery plan, a projection or a request.
		// The gate itself (packages/runtime/tests/recovery-purity.test.ts,
		// ADR-0051 §6 ruling R7) is run unmodified by the suite; this
		// assertion pins the boundary that keeps it green — the runtime's
		// recovery derivation has no import path to the CLI's reader.
		const stateSrc = readFileSync(join(fileURLToPath(new URL("../src", import.meta.url)), "state.ts"), "utf8");
		expect(stateSrc).toContain("readContextLedger");
		const recovery = readFileSync(
			join(fileURLToPath(new URL("../../../packages/runtime/src", import.meta.url)), "recovery-plan.ts"),
			"utf8",
		);
		expect(recovery).not.toContain("trace");
		expect(recovery).not.toContain("readFileSync");
	});
});
