/**
 * The token estimator: runtime context-accounting policy.
 *
 * A stable, monotone chars/4 proxy for the size of a message list. The
 * runtime's context policy, request budget, summary layer, context anchor
 * and request trace read it; the kernel never did.
 *
 * ADR-0043 Amendment 13: moved here unchanged from the core package
 * (`kernel/compaction.ts`). Since ADR-0044 moved compaction into the
 * microcompact boundary, that file held only this estimator, and nothing
 * in core called it — so it left the counted kernel instead of the cap
 * moving.
 */

import type { ContentBlock, Message } from "@vincemakes/kiso-core";

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
	if (typeof content === "string") return textTokens(content);
	let tokens = 0;
	for (const block of content) {
		tokens += block.type === "text" ? textTokens(block.text) : NON_TEXT_BLOCK_TOKENS;
	}
	return tokens;
}

/**
 * 0.40.0 (the owner's session): chars/4, except that a CJK character counts
 * as one token — which is about what a tokenizer spends on one. Plain
 * chars/4 read a Chinese-heavy 730k context as ~470k, so the thresholds
 * never fired and the ctx row lied. Text without CJK scores exactly what
 * it scored before. A counting loop, not a regex match: the text can be
 * megabytes, and a match array would hold one entry per character.
 */
function textTokens(text: string): number {
	let cjk = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		// kana, CJK ext A, unified ideographs, Hangul syllables,
		// compatibility ideographs, full-width forms
		if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) cjk++;
	}
	return cjk + Math.ceil((text.length - cjk) / 4);
}

/**
 * Rough token estimate (chars/4 + structural overhead). Calibration-free on
 * purpose: context economy only needs a stable MONOTONE proxy, not an exact
 * count — the threshold absorbs the error (the predecessor's ADR-0007). The proxy's
 * three-word contract, and the pins that hold it, are
 * packages/core/tests/sc1b-estimator.test.ts (it stays with the
 * kernel-loop cases it also pins).
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
						? textTokens(block.text)
						: textTokens(JSON.stringify(block.input)) + 20;
			}
		} else {
			total += contentTokens(msg.content) + 10;
		}
	}
	return total;
}
