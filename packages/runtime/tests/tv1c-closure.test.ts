/**
 * TV-1C — the projection closure: two holes, both RED before GREEN.
 *
 * ① THE CERTIFICATE CONFUSION (P0). `concurrency: "shared"` is a
 *    SCHEDULING certificate — overlap-safe, nothing more. The session
 *    wiring used it to mean "never mutates", which slow_touch
 *    (shared + writes) disproves. The exemption must come from
 *    `precommitSafe: true` — the frozen read-only+free+local contract.
 *
 * ② VOIDED-CLAIM ADMISSIBILITY. A voided range (voidFromSeq, seq] of
 *    `model_output_abandoned` is the durable vocabulary's own "never
 *    happened" — the kernel projection skips it; the task projection
 *    must too, uniformly: a voided task_set echo is not a claim, a
 *    voided receipt is not evidence, a voided start is not a mutation.
 *    task_set waits for turn commit today (TT-1), so the scheduler
 *    already prevents the claim case — the projection stops RELYING
 *    on that forever-guarantee here.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { defineTool, type Event, type Tool } from "@vincemakes/kiso-core";
import createTaskExtension from "@vincemakes/kiso-task-ext";
import { assessTasks, createAgent, SessionStore } from "../src/index.js";

// ---- the same positional-seq builders as the TV-1A matrix ----

type Ev = Omit<Event, "seq">;
const log = (...evs: Ev[]): Event[] => evs.map((e, seq) => ({ ...e, seq }) as Event);

let nextExec = 0;
function executed(name: string, content: string): Ev[] {
	nextExec += 1;
	const executionId = `x${nextExec}`;
	const callId = `c${nextExec}`;
	return [
		{ type: "tool_execution_started", executionId, callId, name, input: {} } as Ev,
		{ type: "tool_execution_succeeded", executionId, callId, result: { content, isError: false } } as Ev,
	];
}
function started(name: string): Ev[] {
	nextExec += 1;
	return [{ type: "tool_execution_started", executionId: `x${nextExec}`, callId: `c${nextExec}`, name, input: {} } as Ev];
}
const abandoned = (voidFromSeq: number): Ev[] => [
	{ type: "model_output_abandoned", voidFromSeq, reason: "the turn was voided before it committed" } as Ev,
];

const ECHO_MIXED = "[task] 3 items — 1 pending, 1 active, 1 done\n[pending] write the plan\n[active] implement\n[done] read the code";
const ECHO_ALL_DONE = "[task] 2 items — 0 pending, 0 active, 2 done\n[done] implement\n[done] verify with tests";

const opts = { nonMutatingTools: new Set(["read_file"]), evidenceTools: new Set(["shell"]) };

describe("TV-1C ② — voided ranges are 'never happened' for every consumer of the projection", () => {
	it("a voided task_set echo does not update the claims — the last COMMITTED echo stands", () => {
		// seqs: 0,1 task_set MIXED · 2,3 task_set ALL_DONE · 4 abandon(voidFrom 1) → range (1,4]
		const events = log(...executed("task_set", ECHO_MIXED), ...executed("task_set", ECHO_ALL_DONE), ...abandoned(1));
		const a = assessTasks(events, opts);
		expect(a.claims.map((c) => c.status)).toEqual(["pending", "active", "done"]);
		expect(a.allClaimedDone).toBe(false);
		expect(a.lastTaskSetSeq).toBe(1);
	});

	it("a voided evidence receipt does not verify — speculative evidence is not evidence", () => {
		// seqs: 0,1 task_set ALL_DONE · 2,3 shell · 4 abandon(voidFrom 1) → range (1,4]
		const events = log(...executed("task_set", ECHO_ALL_DONE), ...executed("shell", "tests pass"), ...abandoned(1));
		const a = assessTasks(events, opts);
		expect(a.evidence.kind).toBe("none");
	});

	it("a voided mutation-start does not invalidate — the committed evidence survives", () => {
		// seqs: 0,1 task_set ALL_DONE · 2,3 shell · 4 write started · 5 abandon(voidFrom 3) → range (3,5]
		const events = log(...executed("task_set", ECHO_ALL_DONE), ...executed("shell", "tests pass"), ...started("write_file"), ...abandoned(3));
		const a = assessTasks(events, opts);
		expect(a.evidence.kind).toBe("verified");
		if (a.evidence.kind === "verified") expect(a.evidence.evidenceSeq).toBe(3);
		// the last mutation-class start is the shell's OWN start (seq 2 —
		// exclusive evidence is legal, TV-1A), never the voided write at 4
		expect(a.lastMutationSeq).toBe(2);
	});
});

describe("TV-1C ① — the session wiring derives the exemption from the WORLD certificate, not the scheduling one", () => {
	// TT-1A: the task extension now carries its own approvals policy, so
	// ANY agent that installs it is in the chain regime (ADR-0042: with a
	// chain present, all-abstain ASKS — no opinion is never a silent
	// allow). The arc has no human; this harness extension speaks an
	// allow for the arc's own tools (deny > allow > ask: nothing here is
	// denied, so the allow silences the asks and keeps the arc drainable).
	const harnessApprovals = {
		name: "test-harness",
		approvals: [{ decide: () => ({ action: "allow", reason: "the test arc has no human" }) }],
	};

	const shellTool: Tool<{ command: string }> = defineTool<{ command: string }>({
		name: "shell",
		description: "run",
		parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
		execute: async () => ({ content: "ok", isError: false }),
	});
	// The in-repo counterexample's shape: overlap-safe AND effectful.
	// The certificate says calls may interleave — it never said the
	// world is untouched.
	const slowTouch: Tool<{ path: string }> = defineTool<{ path: string }>({
		name: "slow_touch",
		description: "touch a file, slowly",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		effects: { concurrency: "shared" },
		execute: async () => ({ content: "touched", isError: false }),
	});

	const ITEMS_DONE = [
		{ text: "implement", status: "done" },
		{ text: "verify with tests", status: "done" },
	];

	it("an effectful-shared execution AFTER the evidence MUST stale the verdict — through session.assessTasks()", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-tv1c-"));
		const store = new SessionStore(dir);
		const agent = createAgent({
			model: "faux",
			store,
			tools: [shellTool, slowTouch],
			adapter: createFauxProvider([
				{ events: [{ type: "tool_call_end", callId: "t1", name: "task_set", input: { items: ITEMS_DONE } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "tool_call_end", callId: "s1", name: "shell", input: { command: "npm test" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "tool_call_end", callId: "z1", name: "slow_touch", input: { path: "a" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			extensions: [await createTaskExtension(), harnessApprovals as never],
		});
		const session = await agent.session({ id: "tv1c" });
		for await (const _ of session.run("do the work, then touch")) {
			// drain — the faux arc needs no human
		}
		const a = session.assessTasks();
		expect(a.allClaimedDone).toBe(true);
		expect(a.evidence.kind).toBe("stale");
		if (a.evidence.kind === "stale") {
			expect(a.evidence.invalidatedBySeq).toBeGreaterThan(a.evidence.evidenceSeq);
		}
		store.closeAll();
	});
});
