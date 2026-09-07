/**
 * A1a (B) — the single-run growth gate, red first.
 *
 * ONE instruction, two hundred committed model turns, each a write_file
 * call with a ~2.4K-character result (non-compactable by construction).
 * The red half pins the mechanism gap on 0.28.0: the projected context
 * is far above the auto policy's trigger, and `summaryBoundarySeq` finds
 * nothing to cover — one uncovered input can never yield a boundary.
 * The green half: `checkpointBoundarySeq` finds a valid cut inside the
 * same run, and the request budget shows the headroom exhausted.
 */

import { describe, expect, it } from "vitest";
import type { Event, EventInput } from "@vincemakes/kiso-core";
import { estimateTokens, projectMessages } from "@vincemakes/kiso-core";
import { policyTriggerFromWindow, summaryBoundarySeq, KEEP_TOKENS_DEFAULT } from "../src/summarize.js";
import { checkpointBoundarySeq } from "../src/checkpoint.js";
import { requestBudget } from "../src/request-budget.js";

const WINDOW = 120_000;

function singleRun(turns: number): Event[] {
	const out: Event[] = [{ type: "user_input", content: "migrate every module", seq: 0 } as Event];
	let seq = 1;
	const push = (e: EventInput): void => {
		out.push({ ...e, seq } as Event);
		seq += 1;
	};
	for (let i = 0; i < turns; i += 1) {
		push({ type: "tool_call_end", callId: `c${i}`, name: "write_file", input: { path: `src/m${i}.ts`, content: "y".repeat(400) } });
		push({ type: "stop", reason: "tool_use" });
		push({ type: "tool_result", callId: `c${i}`, invocationSeq: seq - 2, content: "wrote ".repeat(400), isError: false } as EventInput);
	}
	push({ type: "text_delta", text: "done" });
	push({ type: "stop", reason: "end_turn" });
	return out;
}

describe("A1a — one instruction, two hundred turns", () => {
	const events = singleRun(200);
	const projected = projectMessages(events);

	it("RED on 0.28.0: the context is above the trigger and the whole-round boundary finds nothing", () => {
		expect(estimateTokens(projected)).toBeGreaterThan(policyTriggerFromWindow(WINDOW));
		expect(summaryBoundarySeq(events)).toBeUndefined();
		expect(summaryBoundarySeq(events, 1, KEEP_TOKENS_DEFAULT)).toBeUndefined();
	});

	it("GREEN: a settled-turn checkpoint exists inside the run, and it keeps the floor", () => {
		const cut = checkpointBoundarySeq(events, { keepTokens: KEEP_TOKENS_DEFAULT });
		expect(cut).toBeTypeOf("number");
		expect(cut!).toBeGreaterThan(0);
		expect(cut!).toBeLessThan(events[events.length - 1]!.seq);
		// the cut sits on a tool_result (a settled turn's last event), never on a stop
		expect(events.find((e) => e.seq === cut)!.type).toBe("tool_result");
	});

	it("the request budget says the headroom is gone", () => {
		const b = requestBudget({ systemPrompt: "sys", toolSpecs: [], messages: projected, maxTokens: 4096 }, WINDOW);
		expect(b.total).toBeGreaterThan(WINDOW);
		expect(b.headroom).toBeLessThan(0);
		expect(b.ratio).toBeGreaterThan(1);
	});
});
