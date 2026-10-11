/** AUDIT: a child's `started` has no invocationSeq, so it fell into the legacy callId matching and could "answer" an unrelated model call that has the same id. */
import { describe, expect, it } from "vitest";
import { unansweredAbortedCalls } from "../src/aborted-calls.js";

const rec = (runId: string, event: Record<string, unknown>) => ({ runId, event }) as never;
describe("aborted calls and children", () => {
	it("a model call `c/1` aborted before it started stays unanswered even though a child with the id `c/1` exists", () => {
		const records = [
			rec("r", { seq: 1, type: "user_input", content: "go" }),
			rec("r", { seq: 2, type: "tool_call_end", callId: "c", name: "prog", input: {} }),
			rec("r", { seq: 3, type: "tool_call_end", callId: "c/1", name: "other", input: {} }),
			rec("r", { seq: 4, type: "stop", reason: "tool_use" }),
			rec("r", { seq: 5, type: "tool_execution_started", executionId: "ex-5", callId: "c", invocationSeq: 2, name: "prog", input: {} }),
			rec("r", { seq: 6, type: "tool_execution_started", executionId: "ex-6", callId: "c/1", name: "kid", input: {}, parent: "ex-5" }), // the program's child
			rec("r", { seq: 7, type: "terminal", outcome: { kind: "aborted", by: "user" } }),
		];
		expect(unansweredAbortedCalls(records).map((c) => c.callId)).toEqual(["c/1"]);
	});
});
