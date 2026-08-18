/**
 * L2 — context-economy primitives, the MECHANICAL half.
 *
 * The kernel's compaction policy is identity preservation, not summary
 * (mauri ADR-0007): keep the message SHELL (id, role, position), replace
 * the content with a marker, zero LLM calls. A summary is a NEW message; it
 * never rewrites an old one. Messages are immutable (ADR-0002) — "clearing"
 * is append, not mutation.
 *
 * ADR-0044 merged the classic auto-compaction (`config.compaction` +
 * `compacted` events) INTO the microcompact boundary: the loop no longer
 * produces `compacted` events (the boundary's projection derives the same
 * cleared view deterministically), and this module now holds only what the
 * live path shares. Old sessions' `compacted` events still replay verbatim
 * — see kernel/project.ts.
 *
 * The model-generated half of context economy (the /compact summary layer)
 * lives in kernel/summarize.ts.
 */

import type { ContentBlock, Message } from "../protocol/messages.js";

/**
 * What a non-text block (an image) contributes. There is no character count
 * to proxy, and this module refuses to guess a provider's image
 * tokenization; the figure exists so a block is never worth ZERO, which is
 * what MONOTONE requires. Deliberately small: under-stating an image is a
 * threshold that fires slightly late, over-stating it is one that fires on
 * a conversation that was never large.
 */
const NON_TEXT_BLOCK_TOKENS = 8;

/**
 * chars/4 over a `string | ContentBlock[]` content field.
 *
 * SC-1b ①: the array arm must be summed BLOCK BY BLOCK. Reading `.length`
 * off it yields the block COUNT — a five-block 50 KB message scored ~2
 * tokens, and the live microcompact threshold believed it.
 */
function contentTokens(content: string | readonly ContentBlock[]): number {
	if (typeof content === "string") return Math.ceil(content.length / 4);
	let tokens = 0;
	for (const block of content) {
		tokens += block.type === "text" ? Math.ceil(block.text.length / 4) : NON_TEXT_BLOCK_TOKENS;
	}
	return tokens;
}

/**
 * Rough token estimate (chars/4 + structural overhead). Calibration-free on
 * purpose: context economy only needs a stable MONOTONE proxy, not an exact
 * count — the threshold absorbs the error (mauri ADR-0007). The proxy's
 * three-word contract, and the pins that hold it, are
 * packages/core/tests/sc1b-estimator.test.ts.
 */
export function estimateTokens(messages: readonly Message[]): number {
	let total = 0;
	for (const msg of messages) {
		if (msg.role === "user") {
			total += contentTokens(msg.content);
		} else if (msg.role === "assistant") {
			for (const block of msg.blocks) {
				total +=
					block.type === "text"
						? Math.ceil(block.text.length / 4)
						: Math.ceil(JSON.stringify(block.input).length / 4) + 20;
			}
		} else {
			total += contentTokens(msg.content) + 10;
		}
	}
	return total;
}
