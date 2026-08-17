/**
 * KC2 T-R4a / T-R4b — the two races, both orderings each, and the rule
 * that keeps them apart.
 *
 * T-R4a  redirect vs the run's TERMINAL.
 *          abort-first    → the run's terminal is `aborted` and the
 *                           correction is the next turn.
 *          terminal-first → the run already finished: the abort is a
 *                           no-op on a dead run, the terminal stays the
 *                           normal one, and the correction is simply a
 *                           plain next turn.
 *
 * T-R4b  the abort vs the TOOL's settlement. These are DIFFERENT AXES and
 *        the round's rule is that they are never conflated:
 *          receipt-first  → the effect is KNOWN. There is a receipt, so
 *                           there is NOTHING uncertain — and the run may
 *                           STILL terminate aborted. An aborted terminal
 *                           must never by itself imply an uncertainty
 *                           ask, or every interrupt would nag.
 *          abort-first    → started, no receipt: the crash-window shape.
 *                           THERE the human is asked, before the next
 *                           turn starts.
 *
 * The contrast between the two T-R4b cases is the point of the pair: same
 * aborted terminal, opposite uncertainty verdicts, decided by the receipt
 * alone.
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
	const dir = mkdtempSync(join(tmpdir(), "kiso-kc2race-"));
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
const inputs = (log: Rec[]): string[] =>
	log.filter((r) => r.event.type === "user_input").map((r) => String(r.event.content));
const outcomes = (log: Rec[]): string[] =>
	log.filter((r) => r.event.type === "terminal").map((r) => String((r.event.outcome as { kind: string }).kind));

/** a turn whose TOOL occupies real wall time — the interrupt window */
const busyTurn = (seconds: number) => ({
	events: [
		{ type: "tool_call_end", callId: "busy", name: "shell", input: { command: `sleep ${seconds}` } },
		{ type: "stop", reason: "tool_use" },
	],
});
const quickTurn = (text: string) => ({
	events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }],
});

function fauxScript(dir: string, turns: unknown[]): string {
	const p = join(dir, "faux.json");
	writeFileSync(p, JSON.stringify(turns), "utf8");
	return p;
}

/** the aborted-mid-tool shape: a CLOSED run whose execution never
 *  reported — started, no receipt (see the gate suite for the note on
 *  why this is seeded rather than driven) */
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

describe("KC2 T-R4a — the redirect races the run's terminal", () => {
	it("abort-first: the run's terminal is aborted and the correction is the next turn", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-kc2-r4a1-"));
		const script = fauxScript(dir, [busyTurn(8), quickTurn("correction answered")]);
		const out = ptyRun({ ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" }, "kc2r4a1", [
			["› ", "the wrong thing\r", 2],
			["working", "the right thing", 4],
			["the right thing", ALT_ENTER, 5], // well inside the run's life
		], 32, ["correction answered"]);
		const log = durable(dirs.home, "kc2r4a1");
		expect(outcomes(log)[0]).toBe("aborted");
		expect(inputs(log)).toEqual(["the wrong thing", "the right thing"]);
		expect(Buffer.from(out, "hex").toString("utf8")).toContain("correction answered");
	}, 180_000);

	it("terminal-first: the run already ended — the abort is a no-op and the correction is a plain next turn", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-kc2-r4a2-"));
		const script = fauxScript(dir, [quickTurn("finished immediately"), quickTurn("second turn answered")]);
		const out = ptyRun({ ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" }, "kc2r4a2", [
			["› ", "a fast task\r", 2],
			["finished immediately", "a follow-up", 5], // the run is long dead
			["a follow-up", ALT_ENTER, 6],
		], 26, ["second turn answered"]);
		const log = durable(dirs.home, "kc2r4a2");
		// nothing was aborted — there was nothing left to abort
		expect(outcomes(log)).toEqual(["completed", "completed"]);
		expect(kinds(log)).not.toContain("uncertain_pending");
		expect(inputs(log)).toEqual(["a fast task", "a follow-up"]);
		expect(Buffer.from(out, "hex").toString("utf8")).toContain("second turn answered");
	}, 180_000);
});

describe("KC2 T-R4b — the abort races the TOOL's settlement (a different axis entirely)", () => {
	it("receipt-first: the effect is KNOWN — the run still aborts, and NOTHING is uncertain", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-kc2-r4b1-"));
		const script = fauxScript(dir, [busyTurn(8), quickTurn("next turn answered")]);
		const out = ptyRun({ ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" }, "kc2r4b1", [
			["› ", "run the slow thing\r", 2],
			["working", "actually, stop", 4],
			["actually, stop", ALT_ENTER, 5],
		], 32, ["next turn answered"]);
		const log = durable(dirs.home, "kc2r4b1");
		const screen = Buffer.from(out, "hex").toString("utf8");

		// the two facts that must coexist without collapsing into each other
		expect(outcomes(log)[0], "the run terminated aborted").toBe("aborted");
		// A RECEIPT landed — that is the whole claim. Which receipt is a
		// separate question: the abort reaches the running shell, so the
		// honest outcome here is `failed`, and ruling #12 (ADR-0038) is
		// explicit that a complete receipt IS the outcome — failed is
		// "failed", never "uncertain". Uncertainty is the crash window's
		// alone: started, and no receipt at all.
		const receipts = kinds(log).filter((k) => k === "tool_execution_succeeded" || k === "tool_execution_failed");
		expect(receipts.length, "the tool's receipt landed — the effect is known").toBe(1);

		// ...and therefore NOTHING is uncertain: no ask, no verdict, no
		// resolution. An aborted terminal alone must never nag the human.
		expect(kinds(log)).not.toContain("tool_execution_resolved");
		expect(kinds(log)).not.toContain("uncertain_pending");
		expect(screen).not.toContain("rerun");

		// the next turn ran straight through, ungated
		expect(inputs(log)).toEqual(["run the slow thing", "actually, stop"]);
		expect(screen).toContain("next turn answered");
	}, 180_000);

	it("abort-first: started with no receipt — the SAME aborted terminal, and here the human IS asked", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-kc2-r4b2-"));
		seedAbortedMidTool(dirs.home, "kc2r4b2");
		const script = fauxScript(dir, [quickTurn("unreachable"), quickTurn("next turn answered")]);
		const out = ptyRun({ ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" }, "kc2r4b2", [
			["rerun", "\x03", 2], // the startup ask is cancelled — nothing recorded
			["› ", "carry on\r", 5],
			["rerun", "1\r", 7], // the gate asks again, before the turn starts
		], 30, ["next turn answered"]);
		const log = durable(dirs.home, "kc2r4b2");

		// the same terminal as the case above...
		expect(outcomes(log)[0]).toBe("aborted");
		// ...but NO receipt — and that, not the terminal, is what makes it
		// uncertain and what makes the human the one who decides.
		expect(kinds(log)).not.toContain("tool_execution_succeeded");
		expect(kinds(log)).not.toContain("tool_execution_failed");
		expect(kinds(log)).toContain("tool_execution_resolved");

		const resolvedAt = kinds(log).indexOf("tool_execution_resolved");
		const freshAt = log.findIndex((r) => r.event.type === "user_input" && r.event.content === "carry on");
		expect(freshAt).toBeGreaterThanOrEqual(0);
		expect(resolvedAt, "the verdict precedes the turn it guards").toBeLessThan(freshAt);
		expect(Buffer.from(out, "hex").toString("utf8")).toContain("next turn answered");
	}, 180_000);
});
