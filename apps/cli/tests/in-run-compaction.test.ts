/**
 * The compaction round (owner, 2026-10-06) — the CLI's view of a summary
 * inside a run: what the running row reads while it is in flight, and the
 * sizes a kept one leaves for the COMPACTED row.
 */

import { afterEach, describe, expect, it } from "vitest";
import { clearInRunSummary, current, onInRunSummary, takeKept } from "../src/in-run-compaction.js";

afterEach(() => clearInRunSummary());

describe("a summary inside a run, as the screen sees it", () => {
	it("start → in flight with its rounds and tokens; progress updates it; end clears it", () => {
		expect(current()).toBeNull();
		onInRunSummary({ phase: "start", reason: "hard", info: { rounds: 42, tokens: 180_000 } });
		expect(current()).toMatchObject({ rounds: 42, tokens: 180_000, progress: null });
		onInRunSummary({ phase: "progress", progress: { produced: 3_100, budget: 8_000, reasoningUnseen: false } });
		expect(current()?.progress).toEqual({ produced: 3_100, budget: 8_000, reasoningUnseen: false });
		onInRunSummary({ phase: "end", outcome: "kept", pre: 180_000, post: 22_000 });
		expect(current()).toBeNull();
	});

	it("a kept summary leaves its sizes once, for the COMPACTED row; discarded and failed leave none", () => {
		onInRunSummary({ phase: "start", reason: "hard", info: { rounds: 1, tokens: 10 } });
		onInRunSummary({ phase: "end", outcome: "kept", pre: 180_000, post: 22_000 });
		expect(takeKept()).toEqual({ pre: 180_000, post: 22_000 });
		expect(takeKept()).toBeNull();
		for (const outcome of ["discarded", "failed"] as const) {
			onInRunSummary({ phase: "start", reason: "hard", info: { rounds: 1, tokens: 10 } });
			onInRunSummary({ phase: "end", outcome, pre: 100, post: 100 });
			expect(takeKept(), outcome).toBeNull();
		}
	});

	it("progress with nothing in flight is ignored; a new start forgets an untaken kept", () => {
		onInRunSummary({ phase: "progress", progress: { produced: 1, budget: 2, reasoningUnseen: false } });
		expect(current()).toBeNull();
		onInRunSummary({ phase: "start", reason: "hard", info: { rounds: 1, tokens: 10 } });
		onInRunSummary({ phase: "end", outcome: "kept", pre: 9, post: 3 });
		onInRunSummary({ phase: "start", reason: "hard", info: { rounds: 2, tokens: 20 } });
		expect(takeKept()).toBeNull();
	});
});
