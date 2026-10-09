/**
 * The 0.49.0 subagents kit's bench apparatus, held to synthetic legs:
 * w1-verify.mjs (adoption required, the change present, the tests green)
 * and subagents-counters.mjs (the join's outcomes, the wakes, the
 * writers' records). An instrument that reads nothing must say so — a
 * missing adoption is a fail, never a silent pass.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { joinOutcome, subagentCounters } from "../bench/subagents-counters.mjs";
import { w1Marks } from "../bench/w1-verify.mjs";

const call = (id: string, input: object) => ({ runId: "r1", event: { type: "tool_call_end", callId: id, name: "delegate", input } });
const result = (id: string, content: string, runId = "r1") => ({ runId, event: { type: "tool_result", callId: id, content } });

describe("subagents-counters — the join's outcomes", () => {
	it("names each outcome from the call's result text", () => {
		expect(joinOutcome("summary: 2 tasks …\n[subagent] explorer: a\n  status: completed · task t1\nok")).toBe("within");
		expect(joinOutcome("summary …\nstill running after 60000 ms: continued as background task t2; …")).toBe("cut");
		expect(joinOutcome("summary …\nmoved to the background by the person: continued as background tasks t1, t2; …")).toBe("person");
		expect(joinOutcome("summary …\nmoved to the background so the person's message could land: continued as background task t1; …")).toBe("steer");
		expect(joinOutcome("summary …\ninterrupted: continued as background task t1; …")).toBe("interrupted");
		expect(joinOutcome("started 2 background children: t1 explorer …")).toBe("started");
	});

	it("counts calls, explicit background, partial joins, wakes and the parent's requests", () => {
		const records = [
			{ runId: "r1", event: { type: "user_input", content: "go" } },
			call("a", { tasks: [{}, {}] }),
			{ runId: "r1", event: { type: "stop" } },
			result("a", "summary: 2 tasks\n[subagent] explorer: q1\n  status: completed · model: m · verification: none · tools: 3 · task t1\nanswer\nstill running after 60000 ms: continued as background task t2; you will be told …"),
			call("b", { tasks: [{}], background: true }),
			{ runId: "r1", event: { type: "stop" } },
			result("b", "started 1 background child: t3 explorer (session s). …"),
			{ runId: "r2", event: { type: "user_input", content: "<kiso-task …/>", via: { kind: "tasks", items: [] } } },
			{ runId: "r2", event: { type: "stop" } },
			{ runId: "r3", event: { type: "user_input", content: "thanks" } },
		];
		const c = subagentCounters(records, []);
		expect(c).toMatchObject({ delegateCalls: 2, explicitBackground: 1, wakes: 1, parentRequests: 3 });
		expect(c.joins).toMatchObject({ cut: 1, partial: 1, started: 1, within: 0 });
	});
});

describe("w1-verify — adoption is required", () => {
	function leg(opts: { adopted: boolean; present: boolean; passing: boolean }) {
		const work = mkdtempSync(join(tmpdir(), "kiso-w1-"));
		const repo = join(work, "repo");
		mkdirSync(join(repo, "src", "items"), { recursive: true });
		mkdirSync(join(repo, "tests"), { recursive: true });
		writeFileSync(join(repo, "src", "items", "validate.js"), opts.present ? "export function skuPrefix(s) { return /^[A-Z]{3}-\\d{4}$/.test(s) ? s.slice(0, 3) : null; }\n" : "export const other = 1;\n");
		if (opts.present) writeFileSync(join(repo, "tests", "sku-prefix.test.js"), `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("t", () => assert.equal(${opts.passing ? "1" : "2"}, 1));\n`);
		else writeFileSync(join(repo, "tests", "other.test.js"), `import { test } from "node:test";\ntest("t", () => {});\n`);
		const task = join(work, "kiso-home", "sessions", "bench-W1-1.tasks", "t1");
		mkdirSync(task, { recursive: true });
		writeFileSync(join(task, "journal.jsonl"), `${JSON.stringify({ type: "planned", agent: { role: "implementer", session: "s", collect: true } })}\n${JSON.stringify({ type: "collected", outcome: "collected" })}\n`);
		writeFileSync(join(task, "result.json"), JSON.stringify({ outcome: "completed", requests: 7 }));
		if (opts.adopted) writeFileSync(join(task, "apply.jsonl"), `${JSON.stringify({ type: "apply_planned" })}\n${JSON.stringify({ type: "publication_complete" })}\n${JSON.stringify({ type: "apply_terminal", outcome: "clean" })}\n`);
		return work;
	}

	it("all three: adopted, present, the tests green", () => {
		expect(w1Marks(leg({ adopted: true, present: true, passing: true }))).toEqual({ adopted: true, present: true, tests: true });
	}, 30_000);

	it("a change made without adopting the patch is a fail", () => {
		expect(w1Marks(leg({ adopted: false, present: true, passing: true })).adopted).toBe(false);
	}, 30_000);

	it("a red test is a fail; an absent change is a fail", () => {
		expect(w1Marks(leg({ adopted: true, present: true, passing: false })).tests).toBe(false);
		expect(w1Marks(leg({ adopted: true, present: false, passing: true })).present).toBe(false);
	}, 30_000);

	it("the writers' record carries the child's requests, the collection and the adoption", () => {
		const work = leg({ adopted: true, present: true, passing: true });
		const c = subagentCounters([], [join(work, "kiso-home", "sessions", "bench-W1-1.tasks", "t1")]);
		expect(c.writers).toEqual([{ task: "t1", role: "implementer", requests: 7, outcome: "completed", endedBy: null, collection: "collected", adopted: "clean", childAcceptance: null, workspaceAcceptance: null }]);
	});
});
