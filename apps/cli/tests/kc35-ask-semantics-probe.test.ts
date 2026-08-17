/**
 * KC3.5 slice ① — THE SEMANTICS PROBE (the round's gate, spec §2).
 *
 * The ask_user moat depends on ONE contract behavior: what does the
 * EXISTING recovery do with an IDEMPOTENT tool's STARTED-unreported
 * execution — the exact shape a kill -9 mid-panel leaves behind?
 *
 *   H1 (the elegant path): the ledger/recovery treats idempotent
 *      started-unreported as safe-to-rerun — the resume RE-EXECUTES the
 *      tool, the panel re-presents, no uncertainty interrogation. The
 *      moat falls out of the frozen contract as-is.
 *
 *   H2: uncertainty blocks REGARDLESS of idempotency — the resume asks
 *      "did it apply? rerun/abandon" first (one meta-hop).
 *
 * This file asserts H1 — the hypothesis under test. It reads the shipped
 * runtime through its PUBLIC surface only (spec §5: the probe may READ
 * anything, change nothing — core/runtime source delta is zero).
 *
 * The fixture is the crash shape the kill9 gate produces and the
 * uncertainty-flow suite seeds: user_input · tool_call_end · stop ·
 * tool_execution_started with NO receipt, in an OPEN run.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool, type Event, type Tool } from "@vincemakes/kiso-core";
import { SessionStore, createAgent, executionLedger } from "@vincemakes/kiso-runtime";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** The faux ask: the tool KC3.5 would ship — asking again is SAFE, so it
 *  declares `idempotent: true` (the twin declares false, to isolate what
 *  the flag actually buys at recovery time). Every execution is recorded,
 *  so "did the framework re-present the question?" is a count. */
function askProbeTool(asked: string[], idempotent: boolean): Tool<{ question: string }> {
	return defineTool<{ question: string }>({
		name: "ask_probe",
		description: "Ask the human a question and return the answer.",
		parameters: {
			type: "object",
			properties: { question: { type: "string" } },
			required: ["question"],
		},
		idempotent,
		execute: async (input) => {
			asked.push(input.question);
			return { content: JSON.stringify({ answers: [{ q: input.question, choice: "vite" }] }), isError: false };
		},
	});
}

const STOP: FauxScript = [{ events: [{ type: "stop", reason: "end_turn" }] }];

const QUESTION = "which bundler?";

/** The kill -9 mid-panel shape: the call is durable, the execution
 *  STARTED, no receipt ever landed, the run never reached a terminal. */
async function seedKilledMidAsk(store: SessionStore, id: string): Promise<void> {
	await store.append(id, "runA", { seq: 0, type: "user_input", content: "set the project up" });
	await store.append(id, "runA", {
		seq: 1,
		type: "tool_call_end",
		callId: "c1",
		name: "ask_probe",
		input: { question: QUESTION },
	});
	await store.append(id, "runA", { seq: 2, type: "stop", reason: "tool_use" });
	await store.append(id, "runA", {
		seq: 3,
		type: "tool_execution_started",
		executionId: "ex-3",
		callId: "c1",
		invocationSeq: 1,
		name: "ask_probe",
		input: { question: QUESTION },
	});
}

function probeAgent(store: SessionStore, asked: string[], idempotent: boolean) {
	return createAgent({
		model: "faux",
		store,
		tools: [askProbeTool(asked, idempotent)],
		adapter: createFauxProvider(STOP),
		permissionPolicy: { rules: [{ tool: "ask_probe", action: "allow" }] },
	});
}

/** Resume to exhaustion; return what came out and what was thrown. */
async function driveResume(session: {
	resume: () => AsyncIterable<Event>;
}): Promise<{ events: Event[]; error: unknown }> {
	const events: Event[] = [];
	try {
		for await (const ev of session.resume()) events.push(ev);
	} catch (err) {
		return { events, error: err };
	}
	return { events, error: undefined };
}

describe("KC3.5 ① — an IDEMPOTENT tool's started-unreported execution, on resume", () => {
	it("H1: the resume re-executes the idempotent tool — the question re-presents, no interrogation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-kc35-h1-"));
		const store = new SessionStore(dir);
		await seedKilledMidAsk(store, "s");
		const asked: string[] = [];
		const session = await probeAgent(store, asked, true).session({ id: "s" });

		// the ledger's own reading of the crash window, before anything runs
		expect(session.uncertainExecutions().map((u) => u.executionId)).toEqual(["ex-3"]);

		const { error } = await driveResume(session);

		// H1: nothing blocks — the resume walks straight back into the tool.
		expect(error, "H1 predicts the resume is not blocked").toBeUndefined();
		// H1: the panel re-presents — the tool ran again, with the SAME question.
		expect(asked, "H1 predicts the idempotent tool is re-executed by the framework").toEqual([QUESTION]);
	});

	it("H1: idempotency is what makes the difference — the NON-idempotent twin is the one that blocks", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-kc35-twin-"));
		const store = new SessionStore(dir);
		await seedKilledMidAsk(store, "s");
		const asked: string[] = [];
		const session = await probeAgent(store, asked, false).session({ id: "s" });
		const { error } = await driveResume(session);

		// H1 predicts the flag is consulted: the non-idempotent twin blocks
		// where the idempotent one sailed through.
		expect(error, "H1 predicts the NON-idempotent twin blocks").toBeDefined();
		expect(asked).toEqual([]);
	});

	it("H1: the durable started event carries the tool's idempotency — the ledger can tell them apart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-kc35-shape-"));
		const store = new SessionStore(dir);
		await seedKilledMidAsk(store, "s");
		const durable = new SessionStore(dir).load("s").map((r) => r.event);
		const started = durable.find((e) => e.type === "tool_execution_started")!;

		// H1 needs the recovery to distinguish idempotent tools from the
		// EVENTS alone (the ledger is a pure projection of the log — it never
		// sees the registry). So the started event must carry the flag.
		expect(
			Object.keys(started).some((k) => /idempot|safeToRetry/i.test(k)),
			"H1 predicts the started event records idempotency",
		).toBe(true);
		// ...and the ledger must not call an idempotent crash-window
		// execution "uncertain".
		expect(executionLedger(durable).get("ex-3")!.status, "H1 predicts a non-uncertain status").not.toBe("uncertain");
	});
});

// ── The human-visible half: the SHIPPED cli, a real PTY, a real
//    idempotent tool (tools-node's read_file declares idempotent: true) ──

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, session, env, timeout, settle, grace):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execvp("node", ["node", cli, "resume", session])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    full = b""
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
        # settle-and-stop: once every asserted outcome is on screen, read
        # for the grace seconds and stop. The timeout is the hang net.
        if settled is None and all(s.encode() in full for s in settle):
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

function ptyResume(env: NodeJS.ProcessEnv, session: string, settle: string[], timeout = 20, grace = 2): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-kc35-pty-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(session)}, ${JSON.stringify(env)}, ${timeout}, ${JSON.stringify(settle)}, ${grace})
`;
	const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 30_000, env: process.env });
	return Buffer.from(out, "hex").toString("utf8");
}

/** The same crash shape, for the SHIPPED idempotent tool `read_file`. */
function seedKilledMidRead(home: string, id: string): void {
	const dir = join(home, "sessions");
	mkdirSync(dir, { recursive: true });
	let seq = 0;
	const lines: string[] = [];
	const push = (event: Record<string, unknown>): void => {
		lines.push(JSON.stringify({ runId: "runA", ts: seq, event: { ...event, seq } }));
		seq += 1;
	};
	push({ type: "user_input", content: "read the config" });
	push({ type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "kiso.json" } });
	push({ type: "stop", reason: "tool_use" });
	push({ type: "tool_execution_started", callId: "c1", invocationSeq: 1, name: "read_file", input: { path: "kiso.json" }, executionId: "ex-3" });
	writeFileSync(join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

describe("KC3.5 ① — what the HUMAN meets on `kiso resume` after an idempotent tool was killed", () => {
	it("H1: no interrogation — a strictly idempotent tool is re-run without asking the human anything", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-kc35-cli-"));
		const script = join(dir, "faux.json");
		writeFileSync(script, JSON.stringify([{ events: [{ type: "text_delta", text: "resume settled" }, { type: "stop", reason: "end_turn" }] }]), "utf8");
		seedKilledMidRead(dirs.home, "kc35probe");
		const screen = ptyResume({ ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" }, "kc35probe", ["resume settled"]);

		// H1 predicts the human is never asked "did it apply?" for a tool
		// that is safe to repeat by declaration.
		expect(screen, "H1 predicts NO uncertainty interrogation for an idempotent tool").not.toContain("rerun");
		expect(screen).not.toContain("interrupted execution");
	}, 60_000);
});
