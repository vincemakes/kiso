/**
 * TV-1A — TaskAssessment as a PURE PROJECTION + Evidence Freshness.
 *
 * The one frozen sentence: Verified ⟹ evidenceSeq > lastRelevantMutationSeq.
 * The projection reads the EXISTING durable vocabulary (no new event kind,
 * zero core diff) and mechanically separates the model's CLAIM (task_set
 * says done) from VERIFIED (fresh evidence exists). Conservatism matches
 * EC-1's certificate direction exactly: a tool name not declared shared is
 * a potential mutation, and the mutation marker is tool_execution_STARTED
 * (intent-to-effect) — so failed and crash-window executions invalidate
 * too, in pre-EC-1 overlap eras as well as post.
 *
 * These inputs are synthesized Event arrays — function inputs, NOT session
 * fixtures; the R4a corpus rule governs generation samples and none is
 * added here. The live leg (real agent, real task extension, real receipts)
 * is at the bottom.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool, type Event, type Tool } from "@vincemakes/kiso-core";
import createTaskExtension from "@vincemakes/kiso-task-ext";
import { assessTasks, createAgent, SessionStore } from "../src/index.js";

// ---- tiny builders: seq is positional (EventLog's own 0..N discipline) ----

type Ev = Omit<Event, "seq">;
const log = (...evs: Ev[]): Event[] => evs.map((e, seq) => ({ ...e, seq }) as Event);

let nextExec = 0;
function started(name: string, input: Record<string, unknown> = {}): Ev[] {
	nextExec += 1;
	return [{ type: "tool_execution_started", executionId: `x${nextExec}`, callId: `c${nextExec}`, name, input } as Ev];
}
function executed(name: string, content: string): Ev[] {
	nextExec += 1;
	const executionId = `x${nextExec}`;
	const callId = `c${nextExec}`;
	return [
		{ type: "tool_execution_started", executionId, callId, name, input: {} } as Ev,
		{ type: "tool_execution_succeeded", executionId, callId, result: { content, isError: false } } as Ev,
	];
}
function failed(name: string): Ev[] {
	nextExec += 1;
	const executionId = `x${nextExec}`;
	const callId = `c${nextExec}`;
	return [
		{ type: "tool_execution_started", executionId, callId, name, input: {} } as Ev,
		{ type: "tool_execution_failed", executionId, callId, error: "boom", safeToRetry: false } as Ev,
	];
}
const user = (content: string): Ev[] => [{ type: "user_input", content } as Ev];

const ECHO_MIXED = "[task] 3 items — 1 pending, 1 active, 1 done\n[pending] write the plan\n[active] implement\n[done] read the code";
const ECHO_ALL_DONE = "[task] 2 items — 0 pending, 0 active, 2 done\n[done] implement\n[done] verify with tests";

const SHARED = new Set(["read_file"]);
const EVIDENCE = new Set(["shell"]);
const opts = { sharedTools: SHARED, evidenceTools: EVIDENCE };

describe("TV-1A — the invariant matrix (pure projection over synthesized logs)", () => {
	it("fresh: evidence is the last intent-to-effect — verdict verified, claims separated from it", () => {
		const events = log(
			...user("go"),
			...executed("task_set", ECHO_MIXED),
			...executed("write_file", "wrote"),
			...executed("task_set", ECHO_ALL_DONE),
			...executed("shell", "tests pass"),
		);
		const a = assessTasks(events, opts);
		expect(a.claims.map((c) => c.status)).toEqual(["done", "done"]);
		expect(a.allClaimedDone).toBe(true);
		expect(a.evidence.kind).toBe("verified");
		if (a.evidence.kind === "verified") {
			// the evidence seq is the shell RECEIPT's seq (the last event here)
			expect(a.evidence.evidenceSeq).toBe(events.length - 1);
		}
	});

	it("stale: a mutation-class start AFTER the evidence names both seqs — never silently upgraded", () => {
		const events = log(
			...executed("task_set", ECHO_ALL_DONE),
			...executed("shell", "tests pass"),
			...executed("write_file", "wrote again"),
		);
		const a = assessTasks(events, opts);
		expect(a.evidence.kind).toBe("stale");
		if (a.evidence.kind === "stale") {
			const shellReceipt = events.find((e) => e.type === "tool_execution_succeeded" && e.result.content === "tests pass");
			const writeStart = events.find((e) => e.type === "tool_execution_started" && (e as { name?: string }).name === "write_file");
			expect(a.evidence.evidenceSeq).toBe(shellReceipt!.seq);
			expect(a.evidence.invalidatedBySeq).toBe(writeStart!.seq);
		}
	});

	it("none: no evidence-class execution ever ran — the projection invents nothing", () => {
		const a = assessTasks(log(...executed("task_set", ECHO_ALL_DONE), ...executed("write_file", "w")), opts);
		expect(a.evidence.kind).toBe("none");
		expect(a.allClaimedDone).toBe(true); // the claim stands AS a claim
	});

	it("a shared-declared success after the evidence does NOT invalidate", () => {
		const a = assessTasks(
			log(...executed("task_set", ECHO_ALL_DONE), ...executed("shell", "pass"), ...executed("read_file", "content")),
			opts,
		);
		expect(a.evidence.kind).toBe("verified");
	});

	it("an UNKNOWN tool name invalidates (the conservative default — absence of a certificate is a mutation)", () => {
		const a = assessTasks(
			log(...executed("task_set", ECHO_ALL_DONE), ...executed("shell", "pass"), ...executed("mystery_tool", "?")),
			opts,
		);
		expect(a.evidence.kind).toBe("stale");
	});

	it("a FAILED exclusive execution invalidates too — failure is not proof of no-effect", () => {
		const a = assessTasks(log(...executed("task_set", ECHO_ALL_DONE), ...executed("shell", "pass"), ...failed("write_file")), opts);
		expect(a.evidence.kind).toBe("stale");
	});

	it("a crash-window start (no receipt) invalidates — uncertainty is a mutation until resolved", () => {
		const a = assessTasks(log(...executed("task_set", ECHO_ALL_DONE), ...executed("shell", "pass"), ...started("write_file")), opts);
		expect(a.evidence.kind).toBe("stale");
	});

	it("task_set itself never invalidates: recording the claim after the check is the NATURAL arc", () => {
		// run tests → THEN mark everything done: the claim-recording act must
		// not eat its own evidence, or verified is unreachable by design.
		const events = log(
			...executed("task_set", ECHO_MIXED),
			...executed("shell", "tests pass"),
			...executed("task_set", ECHO_ALL_DONE),
		);
		const a = assessTasks(events, opts);
		expect(a.evidence.kind).toBe("verified");
		expect(a.claims.map((c) => c.status)).toEqual(["done", "done"]);
	});

	it("the evidence run's own start does not self-invalidate (exclusive evidence is legal)", () => {
		const a = assessTasks(log(...executed("task_set", ECHO_ALL_DONE), ...executed("shell", "pass")), opts);
		expect(a.evidence.kind).toBe("verified");
	});

	it("empty log and task-free log assess to the honest empty — never an error", () => {
		for (const events of [[], log(...user("hi"), ...executed("read_file", "x"))]) {
			const a = assessTasks(events as Event[], opts);
			expect(a.claims).toEqual([]);
			expect(a.allClaimedDone).toBe(false);
			expect(a.lastTaskSetSeq).toBeNull();
			expect(a.evidence.kind).toBe("none");
		}
	});

	it("whole-table replace honored: claims come from the LAST successful task_set only", () => {
		const a = assessTasks(log(...executed("task_set", ECHO_ALL_DONE), ...executed("task_set", ECHO_MIXED)), opts);
		expect(a.claims.map((c) => c.text)).toEqual(["write the plan", "implement", "read the code"]);
		expect(a.allClaimedDone).toBe(false);
	});

	it("a FAILED task_set does not update claims", () => {
		const a = assessTasks(log(...executed("task_set", ECHO_ALL_DONE), ...failed("task_set")), opts);
		expect(a.claims.map((c) => c.status)).toEqual(["done", "done"]);
	});

	it("a garbled echo yields unreadable NAMING seq and reason — nothing is guessed", () => {
		const events = log(...executed("task_set", "[task] 2 items — 0 pending, 0 active, 2 done\n[done] a\n[typo] b"));
		const a = assessTasks(events, opts);
		expect(a.evidence.kind).toBe("unreadable");
		if (a.evidence.kind === "unreadable") {
			expect(a.evidence.atSeq).toBe(events.find((e) => e.type === "tool_execution_succeeded")!.seq);
			expect(a.evidence.reason).toMatch(/line 3/);
		}
		expect(a.claims).toEqual([]);
	});

	it("a count-line lying about its items is unreadable too (the contract is checked, not trusted)", () => {
		const a = assessTasks(log(...executed("task_set", "[task] 2 items — 0 pending, 0 active, 2 done\n[done] only one")), opts);
		expect(a.evidence.kind).toBe("unreadable");
	});

	it("zero-item plan: allClaimedDone is FALSE — an empty plan claims nothing", () => {
		const a = assessTasks(log(...executed("task_set", "[task] 0 items — 0 pending, 0 active, 0 done"), ...executed("shell", "ok")), opts);
		expect(a.claims).toEqual([]);
		expect(a.allClaimedDone).toBe(false);
	});

	it("default classifiers are maximally conservative: no sharedTools (everything mutates), no evidenceTools (nothing proves)", () => {
		const events = log(...executed("task_set", ECHO_ALL_DONE), ...executed("shell", "pass"));
		const a = assessTasks(events);
		expect(a.evidence.kind).toBe("none"); // shell is not evidence unless DECLARED
		const b = assessTasks(events, { evidenceTools: EVIDENCE }); // still: read_file counts as mutation now
		expect(b.evidence.kind).toBe("verified"); // shell last — nothing follows it either way
	});
});

describe("TV-1A — the live leg (real agent, real task extension, real receipts)", () => {
	// The evidence tool is NAMED shell here because the session wrapper's
	// documented default policy is {"shell"}; its handler is a harmless echo.
	const shellTool: Tool<{ command: string }> = defineTool<{ command: string }>({
		name: "shell",
		description: "run",
		parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
		execute: async () => ({ content: "ok", isError: false }),
	});
	const readTool: Tool<{ path: string }> = defineTool<{ path: string }>({
		name: "read_file",
		description: "read",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		effects: { precommitSafe: true, concurrency: "shared" },
		execute: async () => ({ content: "content", isError: false }),
	});

	const ITEMS_MID = [
		{ text: "implement", status: "active" },
		{ text: "verify with tests", status: "pending" },
	];
	const ITEMS_DONE = [
		{ text: "implement", status: "done" },
		{ text: "verify with tests", status: "done" },
	];
	const SCRIPT: FauxScript = [
		{ events: [{ type: "tool_call_end", callId: "t1", name: "task_set", input: { items: ITEMS_MID } }, { type: "stop", reason: "tool_use" }] },
		{ events: [{ type: "tool_call_end", callId: "s1", name: "shell", input: { command: "npm test" } }, { type: "stop", reason: "tool_use" }] },
		{ events: [{ type: "tool_call_end", callId: "t2", name: "task_set", input: { items: ITEMS_DONE } }, { type: "stop", reason: "tool_use" }] },
		{ events: [{ type: "stop", reason: "end_turn" }] },
	];

	it("claimed→verified on the real arc, then a real mutation makes it stale — through session.assessTasks()", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-tv1a-"));
		const store = new SessionStore(dir);
		const agent = createAgent({
			model: "faux",
			store,
			tools: [shellTool, readTool],
			adapter: createFauxProvider(SCRIPT),
			extensions: [await createTaskExtension()],
		});
		const session = await agent.session({ id: "tv1a" });
		for await (const _ of session.run("do the work")) {
			// drain — the faux arc needs no human
		}

		// The wrapper derives sharedTools from the REAL certificates and uses
		// the documented default evidence policy {"shell"}.
		const fresh = session.assessTasks();
		expect(fresh.claims.map((c) => c.status)).toEqual(["done", "done"]);
		expect(fresh.allClaimedDone).toBe(true);
		expect(fresh.evidence.kind).toBe("verified");

		// A second run: a shared-certified read must NOT flip the verdict.
		const agent2 = createAgent({
			model: "faux",
			store,
			tools: [shellTool, readTool],
			adapter: createFauxProvider([
				{ events: [{ type: "tool_call_end", callId: "r1", name: "read_file", input: { path: "a" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			extensions: [await createTaskExtension()],
		});
		const resumed = await agent2.session({ id: "tv1a" });
		for await (const _ of resumed.run("look again")) {
			/* drain */
		}
		expect(resumed.assessTasks().evidence.kind).toBe("verified");

		// A third run: a REAL mutation-class execution (an uncertified test
		// tool — the conservative default) flips the verdict to stale, and
		// the stale verdict names its invalidator.
		const writeTool: Tool<{ path: string }> = defineTool<{ path: string }>({
			name: "write_file",
			description: "write",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			execute: async () => ({ content: "wrote", isError: false }),
		});
		const agent3 = createAgent({
			model: "faux",
			store,
			tools: [shellTool, readTool, writeTool],
			adapter: createFauxProvider([
				{ events: [{ type: "tool_call_end", callId: "w1", name: "write_file", input: { path: "b" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			extensions: [await createTaskExtension()],
		});
		const mutated = await agent3.session({ id: "tv1a" });
		for await (const _ of mutated.run("change something")) {
			/* drain */
		}
		const after = mutated.assessTasks();
		expect(after.evidence.kind).toBe("stale");
		if (after.evidence.kind === "stale") {
			expect(after.evidence.invalidatedBySeq).toBeGreaterThan(after.evidence.evidenceSeq);
		}
		store.closeAll();
	});
});
