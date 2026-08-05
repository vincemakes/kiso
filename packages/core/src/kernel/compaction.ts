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

import type { Message } from "../protocol/messages.js";

/**
 * Rough token estimate (chars/4 + structural overhead). Calibration-free on
 * purpose: context economy only needs a stable MONOTONE proxy, not an exact
 * count — the threshold absorbs the error (mauri ADR-0007).
 */
export function estimateTokens(messages: readonly Message[]): number {
	let total = 0;
	for (const msg of messages) {
		if (msg.role === "user") {
			total += Math.ceil(msg.content.length / 4);
		} else if (msg.role === "assistant") {
			for (const block of msg.blocks) {
				total +=
					block.type === "text"
						? Math.ceil(block.text.length / 4)
						: Math.ceil(JSON.stringify(block.input).length / 4) + 20;
			}
		} else {
			total += Math.ceil(msg.content.length / 4) + 10;
		}
	}
	return total;
}
