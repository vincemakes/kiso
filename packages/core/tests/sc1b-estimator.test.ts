/**
 * SC-1b slice ① — the compaction estimator measures CONTENT, not shape.
 *
 * THE ESTIMATOR CLASS (declared here; anything that moves cites this file):
 * `estimateTokens` is a chars/4 proxy. Its contract is three words, and
 * this file is the whole of it —
 *
 *   HONEST   — a message's estimate tracks the number of CHARACTERS it
 *              carries, whatever container shape holds them. The same text
 *              in `content: string` and in `content: [{type:"text"}]` costs
 *              the same; nothing about the array form makes a payload
 *              cheaper for the provider, so nothing about it may make the
 *              estimate smaller.
 *   MONOTONE — more characters never estimates LOWER. Growing a block's
 *              text grows the estimate; a message with strictly more text
 *              than another never scores under it.
 *   STABLE   — calibration-free and deterministic: no provider call, no
 *              tokenizer, same input to same number.
 *
 * THE BUG this pins (SC-1 escalation 1): the base implementation reached for
 * `msg.content.length` on BOTH arms of `string | ContentBlock[]`. On the
 * array arm that is the BLOCK COUNT — a five-block, 50 KB message estimated
 * FIVE characters' worth, i.e. ~2 tokens. The value feeds the LIVE
 * microcompact threshold (kernel/loop.ts), so a block-shaped session sailed
 * past a threshold it had crossed thousands of tokens earlier.
 *
 * NOT in this class: the keep-window. The estimator decides only WHEN the
 * boundary is drawn; WHAT a boundary preserves is microcompact.test.ts's
 * subject and this round does not touch it.
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import type { ContentBlock, Message } from "../src/protocol/messages.js";
import type { Event } from "../src/protocol/events.js";
import { estimateTokens } from "../src/kernel/compaction.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { EventLog, loop } from "../src/index.js";

const text = (s: string): ContentBlock => ({ type: "text", text: s });
const image = (): ContentBlock => ({ type: "image", sourceType: "url", url: "https://x/y.png" });

/** 50 KB spread over five text blocks — the shape the bug rendered free. */
const FIFTY_K_IN_FIVE_BLOCKS: readonly ContentBlock[] = [
	text("a".repeat(10_000)),
	text("b".repeat(10_000)),
	text("c".repeat(10_000)),
	text("d".repeat(10_000)),
	text("e".repeat(10_000)),
];
const FIFTY_K_AS_STRING = "a".repeat(10_000) + "b".repeat(10_000) + "c".repeat(10_000) + "d".repeat(10_000) + "e".repeat(10_000);

describe("SC-1b ① the estimator is HONEST — blocks are weighed by their text", () => {
	it("a five-block 50 KB user message is worth ~12.5k tokens, not ~2", () => {
		const blocks = estimateTokens([{ role: "user", content: FIFTY_K_IN_FIVE_BLOCKS }]);
		// chars/4 = 12,500. The container shape may cost a little extra; it
		// may never cost three orders of magnitude LESS.
		expect(blocks).toBeGreaterThanOrEqual(12_500);
		expect(blocks).toBeLessThan(13_000);
	});

	it("a five-block 50 KB tool result is worth ~12.5k tokens, not ~2", () => {
		const blocks = estimateTokens([
			{ role: "tool", callId: "c1", content: FIFTY_K_IN_FIVE_BLOCKS, isError: false },
		]);
		expect(blocks).toBeGreaterThanOrEqual(12_500);
		expect(blocks).toBeLessThan(13_000);
	});

	it("the SAME 50 KB costs the same in string form and in block form (within the block overhead)", () => {
		const asString = estimateTokens([{ role: "user", content: FIFTY_K_AS_STRING }]);
		const asBlocks = estimateTokens([{ role: "user", content: FIFTY_K_IN_FIVE_BLOCKS }]);
		expect(Math.abs(asBlocks - asString)).toBeLessThan(50);
	});
});

describe("SC-1b ① the estimator is MONOTONE — more characters never scores lower", () => {
	it("growing a block's text grows the estimate", () => {
		const small = estimateTokens([{ role: "user", content: [text("x".repeat(10))] }]);
		const big = estimateTokens([{ role: "user", content: [text("x".repeat(100_000))] }]);
		expect(big).toBeGreaterThan(small);
	});

	it("40 KB in ONE block outweighs 6 characters in three blocks", () => {
		// The base implementation scored these 1 and 3: fewer, fatter blocks
		// were CHEAPER than more, emptier ones — the counted quantity was
		// the container, not the payload.
		const fat = estimateTokens([{ role: "user", content: [text("x".repeat(40_000))] }]);
		const thin = estimateTokens([{ role: "user", content: [text("xxxx"), text("y"), text("z")] }]);
		expect(fat).toBeGreaterThan(thin);
	});

	it("appending a block never lowers the estimate", () => {
		const before: readonly ContentBlock[] = [text("hello world")];
		const after: readonly ContentBlock[] = [...before, text("and some more"), image()];
		expect(estimateTokens([{ role: "user", content: after }])).toBeGreaterThanOrEqual(
			estimateTokens([{ role: "user", content: before }]),
		);
	});

	it("a non-text block costs a small fixed constant — never zero, and it scales with the count", () => {
		// No character count exists to proxy an image, so it gets a flat
		// per-block figure. The pin is the SHAPE (positive, linear), not the
		// number: an image must never be free, because free breaks MONOTONE.
		const one = estimateTokens([{ role: "user", content: [image()] }]);
		const two = estimateTokens([{ role: "user", content: [image(), image()] }]);
		expect(one).toBeGreaterThan(0);
		expect(two).toBe(2 * one);
	});
});

describe("SC-1b ① the estimator is STABLE — same input, same number", () => {
	it("repeated calls agree, and a mixed conversation is the sum of its messages", () => {
		const convo: readonly Message[] = [
			{ role: "user", content: FIFTY_K_IN_FIVE_BLOCKS },
			{ role: "assistant", blocks: [{ type: "text", text: "ok" }] },
			{ role: "tool", callId: "c1", content: [text("z".repeat(4_000)), image()], isError: false },
		];
		expect(estimateTokens(convo)).toBe(estimateTokens(convo));
		const parts = convo.map((m) => estimateTokens([m])).reduce((a, b) => a + b, 0);
		expect(estimateTokens(convo)).toBe(parts);
	});
});

// ── The live consequence: the microcompact threshold ────────────────────

function seedTenReads(content: string | readonly ContentBlock[]): EventLog {
	const log = new EventLog();
	log.append({ type: "user_input", content: "start" });
	for (let i = 0; i < 10; i++) {
		log.append({ type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.ts` } });
		log.append({ type: "tool_result", callId: `r${i}`, content, isError: false });
		log.append({ type: "user_input", content: `t${i}` });
	}
	return log;
}

async function runOverThreshold(log: EventLog, thresholdTokens: number): Promise<readonly Event[]> {
	const registry = new ToolRegistry();
	const script: FauxScript = [{ events: [{ type: "stop", reason: "end_turn" }] }];
	const events: Event[] = [];
	for await (const ev of loop({
		adapter: createFauxProvider(script),
		model: "faux",
		registry,
		log,
		microcompact: { thresholdTokens },
	})) {
		events.push(ev);
	}
	return events;
}

describe("SC-1b ① the live consequence — the microcompact threshold sees the real size", () => {
	const BODY = "line\n".repeat(400); // 2,000 chars per result, 20 KB in ten
	const THRESHOLD = 2_000; // above the base (shape-counting) score, below the honest one

	it("ten 2 KB results delivered as STRINGS trip the boundary", async () => {
		const log = seedTenReads(BODY);
		await runOverThreshold(log, THRESHOLD);
		expect(log.all.filter((e) => e.type === "microcompacted")).toHaveLength(1);
	});

	it("the SAME ten 2 KB results delivered as BLOCKS trip it too", async () => {
		// The discriminating observation: identical payload, identical
		// threshold, only the container differs. The base implementation
		// scored this session at a fraction of its size and sailed through.
		const log = seedTenReads([text(BODY)]);
		await runOverThreshold(log, THRESHOLD);
		expect(log.all.filter((e) => e.type === "microcompacted")).toHaveLength(1);
	});
});
