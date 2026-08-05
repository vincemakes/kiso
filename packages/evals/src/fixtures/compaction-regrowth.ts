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
 * ADR-0044 merged the classic auto-compaction into the microcompact
 * boundary. The incident's lesson is now STRUCTURAL: a boundary is a
 * persisted fact, so the projection derives the same cleared view from
 * the same events, byte for byte — "re-running compaction" is a pure
 * re-derivation that can never re-archive, overwrite, or grow. The
 * fixture pins that idempotence: replaying the log is identical, and the
 * cleared results carry exactly the ONE placeholder, never a grown
 * re-cleared copy.
 */

import { projectMessages, type EventInput } from "@vincemakes/kiso-core";
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
	staticCheck: () => {
		const violations: string[] = [];
		// A compacted log: two read results, a boundary clearing the first.
		const ev = (seq: number, e: Record<string, unknown>): EventInput =>
			({ seq, ...e }) as unknown as EventInput;
		const log: EventInput[] = [
			ev(0, { type: "user_input", content: "start" }),
			ev(1, { type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a.ts" } }),
			ev(2, { type: "tool_result", callId: "c1", content: "x".repeat(100), isError: false }),
			ev(3, { type: "user_input", content: "again" }),
			ev(4, { type: "tool_call_end", callId: "c2", name: "read_file", input: { path: "b.ts" } }),
			ev(5, { type: "tool_result", callId: "c2", content: "y".repeat(100), isError: false }),
			ev(6, { type: "microcompacted", beforeSeq: 2 }),
		];
		const first = projectMessages(log);
		// Idempotence: replaying the same events derives the SAME
		// projection — nothing grows, nothing is re-archived (the regrowth
		// incident's fix, now structural).
		if (JSON.stringify(first) !== JSON.stringify(projectMessages(log))) {
			violations.push("projection is not byte-stable across replay");
		}
		// The boundary cleared exactly the ONE eligible result (seq ≤ 2,
		// a whitelisted tool): the second result is untouched — never a
		// grown re-cleared copy of the first.
		const tools = first.filter((m): m is Extract<(typeof first)[number], { role: "tool" }> => m.role === "tool");
		const cleared = tools.filter((m) => String(m.content).includes("cleared"));
		const kept = tools.filter((m) => !String(m.content).includes("cleared"));
		if (cleared.length !== 1) {
			violations.push("expected exactly one cleared result after the boundary");
		}
		if (kept.length !== 1) {
			violations.push("the second result must stay untouched");
		}
		return violations;
	},
	requiredTerminal: ["completed"],
};
