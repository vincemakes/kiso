/**
 * Fixture: COMPACTION REGROWTH — repeated compaction re-archives already
 * cleared messages, O(N²), silently overwriting original content.
 *
 * Incident (uooki production, 2026, video pipeline): measured 579 store_calls
 * / 480 archive entries against a naive expectation of 44 — ~10× at 50 turns,
 * extrapolating to 64× at 200 turns and 227× at 1000. Root cause: compaction
 * re-archived messages whose content was already the clear marker, writing
 * to the same revision key and overwriting the original. The fix was one
 * line of idempotence: a marked message is never archived again.
 *
 * The kernel-side shape the fixture pins: `shouldClearContent` returns false
 * for already-marked content — the predicate the compaction loop MUST apply
 * before archiving. The fixture fails if the predicate regresses.
 */

import { CLEARED_MARKER_PREFIX, isClearedMarker, shouldClearContent } from "@vincemakes/kiso-core";
import type { Fixture } from "./types.js";

export const compactionRegrowth: Fixture = {
	name: "compaction-regrowth",
	incident:
		"uooki video pipeline: 579 store_calls vs 44 expected at 50 turns — re-archiving cleared markers overwrote originals (2026)",
	script: [
		{
			events: [
				{ type: "text_start" },
				{ type: "text_delta", text: "simulating long-session compaction cycles" },
				{ type: "text_end" },
				{ type: "stop", reason: "end_turn" },
			],
		},
	],
	staticCheck: (events) => {
		const violations: string[] = [];
		// The one-line idempotence rule — present in the kernel or the
		// fixture fails on the first regression.
		if (shouldClearContent(CLEARED_MARKER_PREFIX + "x")) {
			violations.push("already-cleared content must never be re-cleared");
		}
		if (!shouldClearContent("real tool output")) {
			violations.push("real content must remain clearable");
		}
		if (!isClearedMarker(CLEARED_MARKER_PREFIX + "x")) {
			violations.push("marker prefix detection regressed");
		}
		return violations;
	},
	requiredTerminal: ["completed"],
};
