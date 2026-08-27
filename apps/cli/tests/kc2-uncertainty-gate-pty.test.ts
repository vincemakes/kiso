/**
 * KC2 T-R3 / T-R3b — the Fresh-turn Uncertainty Gate.
 *
 * The gap this closes is real and predates the round: the runtime's
 * FRESH-run path checks only the open-run gate and then persists
 * user_input — there is no uncertainty check on it (ResumeBlockedError
 * lives in the RESUME derivation alone), and the CLI resolved uncertains
 * at startup recovery ONLY, and only once. So a session that still holds
 * an undecided interrupted execution when the REPL opens could start a
 * fresh turn — and reach the model — with a dangling tool_use in its
 * projection and the human never asked.
 *
 * THE STATE UNDER TEST is the one the kernel's own abort boundary
 * documents: "an abort now abandons the launched executions (started
 * without receipt → uncertain)" — a run with a durable `aborted`
 * terminal AND a started execution that never reported. It is seeded as
 * a session fixture here, the way this suite seeds every other durable
 * shape it needs (compact-cli, feel, graceful-exit-release, kill9 all
 * write session JSONL directly), because the in-process abort path
 * cannot currently reach it — see the round report's finding.
 *
 * The startup ask is CANCELLED (Ctrl+C) on purpose: round 10 says a
 * cancellation records nothing, so the execution stays uncertain and
 * durable. That is precisely the moment the old CLI would have let the
 * next turn through, and precisely where the gate now stands.
 *
 * The gate composes EXISTING APIs only — uncertainExecutions(),
 * resolveUncertain(), and the resolution's own model-facing fill: core
 * delta = 0, runtime delta = 0.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");
const ALT_ENTER = "\x1b\r";

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, session, env, feeds, timeout, settle, grace):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execvp("node", ["node", cli, "chat", session])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    full = b""
    fed = set()
    t0 = time.time()
    end = t0 + timeout
    settled = None
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            full += data
        for i, (needle, text, delay) in enumerate(feeds):
            if i not in fed and time.time() - t0 >= delay and needle.encode() in full:
                os.write(fd, text.encode())
                fed.add(i)
        # SETTLED = every feed has fired AND every outcome the test asserts
        # on screen is on screen. The driver then keeps READING for the
        # grace seconds, so the run's terminal and the recap/idle repaint
        # that follow it are persisted before the transcript is cut. The
        # timeout stays as the safety net: a scenario that never settles
        # still ends, and its assertions fail loudly instead of hanging.
        if settled is None and len(fed) == len(feeds) and all(s.encode() in full for s in settle):
            settled = time.time()
        if settled is not None and time.time() - settled >= grace:
            break
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    sys.stdout.write(full.hex())
    sys.exit(0)
`;

/** Run the built CLI under a 24×80 pty. `settle` names the outcomes the
 *  test asserts on screen: once every feed has fired and all of them have
 *  appeared, the driver reads for two more seconds (so the terminal and
 *  the idle repaint land durably) and stops — it never burns the whole
 *  window. `timeout` is the hang safety net. Blocking the vitest worker
 *  for a full 30-40s window is what tripped the reporter's onTaskUpdate
 *  RPC and flipped the process exit code on a green suite. */
function ptyRun(
	env: NodeJS.ProcessEnv,
	session: string,
	feeds: [string, string, number][],
	timeout: number,
	settle: string[],
	grace = 2,
): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-kc2u-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(session)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${timeout}, ${JSON.stringify(settle)}, ${grace})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 180_000, env: process.env });
}

interface Rec {
	readonly runId: string;
	readonly event: Record<string, unknown>;
}

function durable(home: string, session: string): Rec[] {
	return readFileSync(join(home, "sessions", `${session}.jsonl`), "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l) as Rec);
}

const kinds = (log: Rec[]): string[] => log.map((r) => String(r.event.type));

/**
 * Seed the aborted-mid-tool shape: a CLOSED run (terminal: aborted) whose
 * `shell` execution started and never reported. The run is closed, so the
 * startup resume has nothing to recover and the REPL opens normally —
 * with one uncertain execution and one unanswered tool_use waiting in the
 * projection.
 */
function seedAbortedMidTool(home: string, id: string): void {
	const dir = join(home, "sessions");
	mkdirSync(dir, { recursive: true });
	let seq = 0;
	const lines: string[] = [];
	const push = (event: Record<string, unknown>): void => {
		lines.push(JSON.stringify({ runId: "runA", ts: seq, event: { ...event, seq } }));
		seq += 1;
	};
	push({ type: "user_input", content: "clean up the temp files" });
	push({ type: "tool_call_end", callId: "danger", name: "shell", input: { command: "rm -rf ./tmp-build" } });
	push({ type: "tool_execution_started", callId: "danger", invocationSeq: 1, name: "shell", input: { command: "rm -rf ./tmp-build" }, executionId: "ex-2" });
	push({ type: "terminal", outcome: { kind: "aborted", by: "user" } });
	writeFileSync(join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

const quickTurn = (text: string) => ({
	events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }],
});

function fauxScript(dir: string, turns: unknown[]): string {
	const p = join(dir, "faux.json");
	writeFileSync(p, JSON.stringify(turns), "utf8");
	return p;
}

describe("KC2 T-R3 — a fresh turn behind an undecided interrupted execution asks BEFORE the model", () => {
	it("the startup ask is cancelled, the turn is redirected in, and the verdict still lands FIRST", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-kc2-r3-"));
		seedAbortedMidTool(dirs.home, "kc2r3");
		// fauxSkip counts the seeded run's unfinished call as consumed, so
		// the script's FIRST turn is the one the fresh turn will reach.
		const script = fauxScript(dir, [quickTurn("unreachable"), quickTurn("run B done")]);
		const out = ptyRun({ ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" }, "kc2r3", [
			["rerun", "\x03", 2], // Ctrl+C cancels the STARTUP ask — nothing is recorded
			["/ commands · \u2191 history", "only the logs, not the build dir", 5],
			["only the logs", ALT_ENTER, 6], // the correction, one gesture
			["rerun", "1\r", 8], // THE GATE re-asks: 1 = it did not apply, rerun
		], 30, ["run B done"]);
		const log = durable(dirs.home, "kc2r3");
		const screen = Buffer.from(out, "hex").toString("utf8");

		// ① the human was asked TWICE about the same execution: once at
		//    startup (cancelled — nothing recorded) and once by the gate.
		expect(screen.split("rerun").length - 1).toBeGreaterThanOrEqual(2);

		// ② THE GATE: the verdict is durable BEFORE the fresh turn's
		//    user_input — and user_input is persisted before ANY model
		//    call, so the human decided before the model was asked anything.
		const resolvedAt = kinds(log).indexOf("tool_execution_resolved");
		const inputs = log.map((r, i) => ({ i, r })).filter((x) => x.r.event.type === "user_input");
		expect(resolvedAt, "the resolution is durable").toBeGreaterThanOrEqual(0);
		expect(inputs.length).toBe(2); // the seeded one + the correction
		expect(String(inputs[1]!.r.event.content)).toBe("only the logs, not the build dir");
		expect(resolvedAt).toBeLessThan(inputs[1]!.i);

		// ③ the verdict was the human's own — 1 = rerun
		expect(String(log[resolvedAt]!.event.resolution)).toBe("rerun");

		// ④ and the turn then really ran
		expect(screen).toContain("run B done");
	}, 180_000);
});

describe("KC2 T-R3b — the resolution repairs the projection: no dangling tool_use", () => {
	it("the mid-tool call is ANSWERED before the fresh turn's request is built", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-kc2-r3b-"));
		seedAbortedMidTool(dirs.home, "kc2r3b");
		const script = fauxScript(dir, [quickTurn("unreachable"), quickTurn("run B done")]);
		const out = ptyRun({ ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" }, "kc2r3b", [
			["rerun", "\x03", 2],
			["/ commands · \u2191 history", "only the logs, not the build dir", 5],
			["only the logs", ALT_ENTER, 6],
			["rerun", "2\r", 8], // 2 = abandon (the simple flavor is a two-row list now); the fill must land either way
		], 30, ["run B done"]);
		const log = durable(dirs.home, "kc2r3b");

		// the boundary: everything durable BEFORE the fresh turn's
		// user_input is exactly what that turn's FIRST request projects.
		const inputs = log.map((r, i) => ({ i, r })).filter((x) => x.r.event.type === "user_input");
		expect(inputs.length).toBe(2);
		const beforeFresh = log.slice(0, inputs[1]!.i);

		const calls = beforeFresh.filter((r) => r.event.type === "tool_call_end").map((r) => String(r.event.callId));
		const answered = new Set(beforeFresh.filter((r) => r.event.type === "tool_result").map((r) => String(r.event.callId)));
		expect(calls).toEqual(["danger"]);
		for (const id of calls) {
			expect(answered.has(id), `tool_use ${id} is dangling into the fresh turn's request`).toBe(true);
		}

		// the fill is the RESOLUTION's — keyed by the execution, and honest
		// about what it means: an abandoned attempt must never read as
		// applied, and it is an error result, not a fabricated success.
		const fill = beforeFresh.find((r) => r.event.type === "tool_result" && r.event.executionId === "ex-2");
		expect(fill, "the resolution's model-facing fill is durable").toBeDefined();
		expect(String(fill!.event.content)).toContain("abandoned");
		expect(fill!.event.isError).toBe(true);
		expect(String(log[kinds(log).indexOf("tool_execution_resolved")]!.event.resolution)).toBe("abandoned");

		expect(Buffer.from(out, "hex").toString("utf8")).toContain("run B done");
	}, 180_000);
});

describe("KC2 §4 — a declined verdict HOLDS the turn, and says so", () => {
	it("cancelling the gate's ask leaves the execution uncertain, the turn unrun, and the text visible", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-kc2-r3d-"));
		seedAbortedMidTool(dirs.home, "kc2r3d");
		const script = fauxScript(dir, [quickTurn("unreachable"), quickTurn("must not run")]);
		const out = ptyRun({ ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" }, "kc2r3d", [
			["rerun", "\x03", 2], // the startup ask — cancelled
			["/ commands · \u2191 history", "please carry on anyway\r", 5],
			["rerun", "\x03", 7], // the GATE's ask — cancelled too
		], 26, ["turn held"]);
		const log = durable(dirs.home, "kc2r3d");
		const screen = Buffer.from(out, "hex").toString("utf8");

		// round 10: a cancellation records NOTHING — no verdict is fabricated
		expect(kinds(log)).not.toContain("tool_execution_resolved");
		// the turn never started: no second user_input, no model answer
		expect(log.filter((r) => r.event.type === "user_input").length).toBe(1);
		expect(screen).not.toContain("must not run");
		// ...and it was not swallowed in silence — the held text is on screen
		expect(screen).toContain("turn held");
	}, 180_000);
});

describe("KC2 §4 — the gate guards EVERY fresh queued turn, not only redirects", () => {
	it("an ordinary Enter is gated too — the ask precedes the typed turn", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-kc2-r3c-"));
		seedAbortedMidTool(dirs.home, "kc2r3c");
		const script = fauxScript(dir, [quickTurn("unreachable"), quickTurn("typed turn done")]);
		const out = ptyRun({ ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" }, "kc2r3c", [
			["rerun", "\x03", 2], // the startup ask is cancelled
			["/ commands · \u2191 history", "typed by hand\r", 5], // a plain Enter — no redirect anywhere
			["rerun", "1\r", 7],
		], 30, ["typed turn done"]);
		const log = durable(dirs.home, "kc2r3c");
		const resolvedAt = kinds(log).indexOf("tool_execution_resolved");
		const inputs = log.map((r, i) => ({ i, r })).filter((x) => x.r.event.type === "user_input");
		expect(resolvedAt).toBeGreaterThanOrEqual(0);
		expect(inputs.length).toBe(2);
		expect(String(inputs[1]!.r.event.content)).toBe("typed by hand");
		expect(resolvedAt).toBeLessThan(inputs[1]!.i);
		expect(Buffer.from(out, "hex").toString("utf8")).toContain("typed turn done");
	}, 180_000);
});
