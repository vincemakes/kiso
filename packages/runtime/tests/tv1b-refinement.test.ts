/**
 * TV-1B ① — the precondition refinement (two-pass pure projection) and
 * the run() provenance seam.
 *
 * WR-1A made `precondition` receipts PROOF that work never began; the
 * mutation classifier now honors that proof: a started execution whose
 * terminal receipt is failed(errorKind:"precondition") is EXCLUDED from
 * the mutation candidates. Everything else stays conservative —
 * no-receipt (crash window), fatal/transient/invalid_input failures,
 * successes, and legacy receipts with no errorKind at all.
 *
 * The seam: `session.run(input, { source })` threads the EXISTING
 * MessageSource provenance into the durable user_input — no new event,
 * no new variant, no new export name. `source:"system"` is provenance,
 * not provider-role authority.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import type { Event } from "@vincemakes/kiso-core";
import { assessTasks, createAgent, SessionStore } from "../src/index.js";

type Ev = Omit<Event, "seq">;
const log = (...evs: Ev[]): Event[] => evs.map((e, seq) => ({ ...e, seq }) as Event);

let n = 0;
function executed(name: string, content: string): Ev[] {
	n += 1;
	const executionId = `x${n}`;
	const callId = `c${n}`;
	return [
		{ type: "tool_execution_started", executionId, callId, name, input: {} } as Ev,
		{ type: "tool_execution_succeeded", executionId, callId, result: { content, isError: false } } as Ev,
	];
}
function failedWith(name: string, errorKind: string | undefined): Ev[] {
	n += 1;
	const executionId = `x${n}`;
	const callId = `c${n}`;
	return [
		{ type: "tool_execution_started", executionId, callId, name, input: {} } as Ev,
		{ type: "tool_execution_failed", executionId, callId, error: "refused", safeToRetry: false, ...(errorKind !== undefined ? { errorKind } : {}) } as Ev,
	];
}
function startedOnly(name: string): Ev[] {
	n += 1;
	return [{ type: "tool_execution_started", executionId: `x${n}`, callId: `c${n}`, name, input: {} } as Ev];
}

const ECHO_DONE = "[task] 1 item — 0 pending, 0 active, 1 done\n[done] ship it";
const opts = { nonMutatingTools: new Set(["read_file"]), evidenceTools: new Set(["shell"]) };

describe("TV-1B ① — a precondition receipt proves no mutation", () => {
	it("the natural arc: tests pass → stale-refused write → STILL verified", () => {
		const a = assessTasks(
			log(...executed("task_set", ECHO_DONE), ...executed("shell", "tests pass"), ...failedWith("write_file", "precondition")),
			opts,
		);
		expect(a.evidence.kind).toBe("verified");
	});

	it("the interleave the naive rollback breaks on: START A, START B, PRECONDITION-receipt A — B still invalidates", () => {
		// two exclusive executions overlap (a pre-EC-1-era shape); A's
		// receipt proves A never ran, but B is still in its crash window.
		const events = log(
			...executed("task_set", ECHO_DONE),
			...executed("shell", "tests pass"),
			{ type: "tool_execution_started", executionId: "xa", callId: "ca", name: "edit_file", input: {} } as Ev,
			{ type: "tool_execution_started", executionId: "xb", callId: "cb", name: "write_file", input: {} } as Ev,
			{ type: "tool_execution_failed", executionId: "xa", callId: "ca", error: "stale", safeToRetry: false, errorKind: "precondition" } as Ev,
		);
		const a = assessTasks(events, opts);
		expect(a.evidence.kind).toBe("stale"); // B's window is still open
	});

	it("fatal, kind-less, and receipt-less executions all stay conservative mutations", () => {
		for (const tail of [failedWith("write_file", "fatal"), failedWith("write_file", undefined), startedOnly("write_file")]) {
			const a = assessTasks(log(...executed("task_set", ECHO_DONE), ...executed("shell", "pass"), ...tail), opts);
			expect(a.evidence.kind).toBe("stale");
		}
	});

	it("a precondition-refused execution BEFORE the evidence changes nothing (it was never a mutation)", () => {
		const a = assessTasks(
			log(...executed("task_set", ECHO_DONE), ...failedWith("write_file", "precondition"), ...executed("shell", "tests pass")),
			opts,
		);
		expect(a.evidence.kind).toBe("verified");
		// the SHELL's own started (exclusive) is the last mutation candidate;
		// the proven-no-mutation write (its started at seq 2) never counts.
		expect(a.lastMutationSeq).not.toBe(2);
	});
});

describe("TV-1B ① — the run() provenance seam", () => {
	it("run(input, { source }) persists user_input.source durably; omitted stays absent", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-tv1b-seam-"));
		const store = new SessionStore(dir);
		const script: FauxScript = [
			{ events: [{ type: "stop", reason: "end_turn" }] },
			{ events: [{ type: "stop", reason: "end_turn" }] },
		];
		const session = await createAgent({ model: "faux", store, tools: [], adapter: createFauxProvider(script) }).session({ id: "s" });
		for await (const _ of session.run("a plain user line")) {
			/* drain */
		}
		for await (const _ of session.run("Verify the completed work.", { source: "system" })) {
			/* drain */
		}
		store.closeAll();
		const events = new SessionStore(dir).load("s").map((r) => r.event);
		const inputs = events.filter((e): e is Event & { type: "user_input" } => e.type === "user_input");
		expect(inputs).toHaveLength(2);
		expect(inputs[0]!.source).toBeUndefined();
		expect(inputs[1]!.source).toBe("system");
	});
});
