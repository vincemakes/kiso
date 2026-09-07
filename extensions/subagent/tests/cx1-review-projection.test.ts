/**
 * CX-1 review (2026-09-07) P2 — the delegation's result projection honors
 * the kernel's void scope.
 *
 * The reviewer drove the REAL loop: a draft "DISCARDED DRAFT." streamed,
 * the provider failed, the retry answered "FINAL ANSWER." — the durable
 * log carries both, with a `model_output_abandoned` marker voiding the
 * draft. The canonical projection (core project.ts) yields only the final
 * answer; the extractor glued both together and reported success. The
 * invariant: `extractChildResult` reads the child's log the way the kernel
 * reads it — a voided text_delta is not the answer, a voided tool_call_end
 * never ran and is not counted.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractChildResult } from "../dist/kiso-subagent.mjs";

function childLog(events: object[]): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-cx1r-"));
	writeFileSync(join(dir, "child.jsonl"), events.map((event) => JSON.stringify({ runId: "one-run", ts: 1, event })).join("\n") + "\n");
	return dir;
}

describe("CX-1 review P2 — extractChildResult over a voided draft", () => {
	it("the reviewer's shape: a discarded draft, then the final answer — only the final answer is the result", async () => {
		const dir = childLog([
			{ type: "text_delta", text: "DISCARDED DRAFT.", seq: 1 },
			{ type: "model_output_abandoned", voidFromSeq: 0, reason: "the provider stream failed before this turn committed", seq: 2 },
			{ type: "text_delta", text: "FINAL ANSWER.", seq: 3 },
			{ type: "stop", reason: "end_turn", seq: 4 },
			{ type: "terminal", outcome: { kind: "completed" }, seq: 5 },
		]);
		const r = await extractChildResult(dir, "child", "");
		expect(r.text).toBe("FINAL ANSWER.");
		expect(r.failed).toBe(false);
		expect(r.outcome).toBe("completed");
		expect(r.toolCalls).toBe(0);
	});

	it("a voided tool call is not counted; the committed one after the retry is", async () => {
		const dir = childLog([
			{ type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a" }, seq: 1 },
			{ type: "model_output_abandoned", voidFromSeq: 0, reason: "cut", seq: 2 },
			{ type: "tool_call_end", callId: "c2", name: "read_file", input: { path: "a" }, seq: 3 },
			{ type: "stop", reason: "tool_use", seq: 4 },
			{ type: "tool_result", callId: "c2", content: "a", isError: false, seq: 5 },
			{ type: "text_delta", text: "done", seq: 6 },
			{ type: "stop", reason: "end_turn", seq: 7 },
			{ type: "terminal", outcome: { kind: "completed" }, seq: 8 },
		]);
		const r = await extractChildResult(dir, "child", "");
		expect(r.toolCalls).toBe(1);
		expect(r.text).toBe("done");
	});
});
