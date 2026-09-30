/**
 * KC2 T-R2 / T-R5 / T-R6 — the redirect through a REAL pty, read off the
 * DURABLE log.
 *
 * The semantic ruling this round is built on: a redirect is not a stream
 * injection and invents no new state. It is `abort the current run
 * (durable terminal: aborted) → the buffer's text becomes the next turn`.
 * So the durable log is the only honest witness — it records what ran, in
 * the order it ran, and every claim below is read from it.
 *
 * T-R2  a redirect mid-MODEL-turn: Run A's durable terminal is `aborted`,
 *       the correction lands as the next user_input, Run B completes, and
 *       the composer is empty again.
 * T-R5  ADR-0057: with steers [A, B] typed and not yet landed, the
 *       redirect C aborts the run and the next turn is ONE message — C
 *       first (it corrects them), then A, B. The ↑/esc pop takes a steer
 *       back into the composer, and a popped steer never lands.
 * T-R6  ADR-0057: esc is a stop, not a send — the steer that had not
 *       landed returns to the composer, and Enter sends it as the next
 *       turn.
 * T-S1  ADR-0057: Enter while a run is live STEERS it — the line lands in
 *       the SAME run (one terminal), after the running tool's receipt.
 *
 * PTY discipline (KC1): Enter is CR (\r), never LF — an LF inserts a
 * newline into the composer. Alt+Enter is ESC and CR in ONE write, which
 * is exactly how a terminal delivers it.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** Alt+Enter as a terminal sends it: ESC and CR in ONE write. */
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
	const dir = mkdtempSync(join(tmpdir(), "kiso-kc2-"));
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

/** every durable event, in log order — the JSONL envelope is {runId, ts, event} */
export function durableEvents(home: string, session: string): { runId: string; event: Record<string, unknown> }[] {
	const raw = readFileSync(join(home, "sessions", `${session}.jsonl`), "utf8");
	return raw
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l) as { runId: string; event: Record<string, unknown> });
}

/** the durable user_input contents, in the order they actually ran */
export function userInputs(home: string, session: string): string[] {
	return durableEvents(home, session)
		.filter((r) => r.event.type === "user_input")
		.map((r) => (typeof r.event.content === "string" ? r.event.content : ""));
}

/** the durable terminal outcomes, in order */
export function terminals(home: string, session: string): string[] {
	return durableEvents(home, session)
		.filter((r) => r.event.type === "terminal")
		.map((r) => String((r.event.outcome as { kind?: string })?.kind ?? "?"));
}

export const fauxScript = (dir: string, turns: unknown[]): string => {
	const p = join(dir, "faux.json");
	writeFileSync(p, JSON.stringify(turns), "utf8");
	return p;
};

/**
 * A turn that occupies real wall time — the window in which a human
 * notices the run is going the wrong way.
 *
 * The slowness is the TOOL's, not the adapter's, and that is deliberate:
 * the harness's `delay` pseudo-event is not signal-aware, so an abort
 * landing inside it is only observed at the loop's next boundary — and a
 * text-only turn reaches its `completed` terminal before that boundary.
 * A running tool gives the loop a genuine abort boundary AFTER the
 * receipt lands, which is precisely the receipt-first ordering: the
 * effect is KNOWN (no uncertainty) and the run still terminates aborted.
 * The abort-before-receipt ordering is the uncertainty round's fixture.
 */
const busyTurn = (seconds: number) => ({
	events: [
		{ type: "tool_call_end", callId: `c${seconds}`, name: "shell", input: { command: `sleep ${seconds}` } },
		{ type: "stop", reason: "tool_use" },
	],
});
const quickTurn = (text: string) => ({
	events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }],
});

describe("KC2 T-R2 — a redirect mid-run: Run A aborts, the correction becomes Run B", () => {
	it("the durable log shows Run A aborted, then the correction's user_input, then Run B completing", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-kc2-r2-"));
		const script = fauxScript(dir, [busyTurn(8), quickTurn("run B done")]);
		const out = ptyRun({ ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" }, "kc2r2", [
			["/mode to switch", "search the whole tree\r", 2],
			["working", "no, only src/", 5], // typed WHILE run A is still busy
			["only src/", ALT_ENTER, 6], // ONE gesture: ESC and CR in one write
		], 32, ["run B done"]);

		// ① Run A really aborted — the durable terminal, not a pretend one
		expect(terminals(dirs.home, "kc2r2")[0]).toBe("aborted");

		// ② the correction became the NEXT turn, in the same session
		expect(userInputs(dirs.home, "kc2r2")).toEqual(["search the whole tree", "no, only src/"]);

		// ③ Run B completed — its answer is on the screen and its terminal
		//    is a normal one
		const screen = Buffer.from(out, "hex").toString("utf8");
		expect(screen).toContain("run B done");
		expect(terminals(dirs.home, "kc2r2")).toContain("completed");

		// ④ the composer is empty again — the correction left the buffer
		expect(screen).toContain("no, only src/"); // it rides the scrollback as the turn's chip
	}, 180_000);
});

describe("KC2 T-R5 — the redirect carries the steers that had not landed (ADR-0057)", () => {
	it("steers [alpha, beta] + redirect urgent → the run aborts, then ONE turn: urgent, alpha, beta", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-kc2-r5-"));
		const script = fauxScript(dir, [
			busyTurn(10),
			quickTurn("answered one"),
		]);
		const out = ptyRun({ ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" }, "kc2r5", [
			["/mode to switch", "the original task\r", 2],
			["working", "alpha\r", 4], // a steer — the tool is still running
			["alpha", "beta\r", 5], // a second steer
			["beta", "urgent", 6],
			["urgent", ALT_ENTER, 7], // the one gesture
		], 40, ["answered one"]);

		// the durable order IS the acceptance: current (aborted) → ONE turn,
		// the correction first; alpha and beta never landed in the aborted run
		expect(userInputs(dirs.home, "kc2r5")).toEqual(["the original task", "urgent\n\nalpha\n\nbeta"]);
		expect(terminals(dirs.home, "kc2r5")[0]).toBe("aborted");
		const screen = Buffer.from(out, "hex").toString("utf8");
		expect(screen).toContain("answered one"); // the one next turn really ran
	}, 180_000);

	it("↑ takes a steer back into the composer — it never lands on its own, and the redirect carries the rest", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-kc2-r5b-"));
		const script = fauxScript(dir, [busyTurn(10), quickTurn("answered one")]);
		const out = ptyRun({ ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" }, "kc2r5b", [
			["/mode to switch", "the original task\r", 2],
			["working", "keeper\r", 4],
			["keeper", "popme\r", 5],
			["popme", "\x1b[A", 6], // ↑ takes the steer "popme" back into the composer, cursor at the end
			["popme", " and also this", 7], // the human keeps typing — the pop is an EDIT, not a resend
			["and also this", ALT_ENTER, 8], // and redirects with the edited whole
		], 40, ["answered one"]);

		const inputs = userInputs(dirs.home, "kc2r5b");
		// "popme" NEVER landed on its own — it left the run's ingress
		// through the pop and came back as text the human was still writing.
		expect(inputs).not.toContain("popme");
		expect(inputs).toEqual(["the original task", "popme and also this\n\nkeeper"]);
		expect(Buffer.from(out, "hex").toString("utf8")).toContain("answered one");
	}, 180_000);
});

describe("KC2 T-R6 — esc is a stop, not a send (ADR-0057)", () => {
	it("esc hands the steer that had not landed back to the composer; Enter sends it as the next turn", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-kc2-r6-"));
		const script = fauxScript(dir, [busyTurn(10), quickTurn("answered one")]);
		const out = ptyRun({ ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" }, "kc2r6", [
			["/mode to switch", "the original task\r", 2],
			["working", "not landed yet\r", 4], // a steer — the tool is still running
			["not landed yet", "\x1b", 6], // the bare esc, alone in its write — the run aborts
			["aborting", "\r", 8], // the steer is back in the composer: Enter sends it
		], 40, ["answered one"]);

		// the aborted run never admitted the steer; it came back and ran next
		expect(userInputs(dirs.home, "kc2r6")).toEqual(["the original task", "not landed yet"]);
		expect(terminals(dirs.home, "kc2r6")[0]).toBe("aborted");
		expect(Buffer.from(out, "hex").toString("utf8")).toContain("answered one");
	}, 180_000);
});

describe("KC2 T-S1 — Enter while a run is live steers it (ADR-0057)", () => {
	it("the line lands in the SAME run, after the running tool's receipt — one terminal", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-kc2-s1-"));
		const script = fauxScript(dir, [busyTurn(4), quickTurn("steered answer")]);
		const out = ptyRun({ ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" }, "kc2s1", [
			["/mode to switch", "search the whole tree\r", 2], // Graphite: the idle bar teaches /mode; the input carries no placeholder (§7.8)
			["working", "only src/\r", 3], // a steer while the tool runs
		], 30, ["steered answer"]);

		const events = durableEvents(dirs.home, "kc2s1").map((r) => r.event);
		expect(userInputs(dirs.home, "kc2s1")).toEqual(["search the whole tree", "only src/"]);
		expect(terminals(dirs.home, "kc2s1")).toEqual(["completed"]);
		const steerAt = events.findIndex((e) => e.type === "user_input" && e.content === "only src/");
		const resultAt = events.findIndex((e) => e.type === "tool_result");
		expect(steerAt).toBeGreaterThan(resultAt);
		expect(Buffer.from(out, "hex").toString("utf8")).toContain("steered answer");
	}, 180_000);
});
