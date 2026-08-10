/**
 * R-E 0.1.44 — the healing fixtures: the three REAL sessions that caught the
 * round's P1 live (dogfood-0143, dogfood-0143b, the review's review-0143),
 * verbatim (byte-identical jsonls in ./fixtures/sessions/). The fix is a
 * pure DERIVATION change — "persist facts, derive state" — so loading each
 * poisoned log and projecting it must come out PAIR-CLEAN: every projected
 * tool_use has its tool message and vice versa (the two provider 400s were
 * exactly the unpaired tool_use and the orphan tool_result). The poison
 * heals retroactively; nothing in these logs is rewritten.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectMessages } from "@vincemakes/kiso-core";

const FIXTURE_DIR = new URL("./fixtures/sessions/", import.meta.url);

const SESSIONS = ["dogfood-0143", "dogfood-0143b", "review-0143"] as const;

/** The provider pairing invariant: an assistant tool_use per tool message
 *  and vice versa (the live 400s' shapes, both directions). */
const pairClosed = (msgs: ReturnType<typeof projectMessages>): boolean => {
	const calls = msgs
		.filter((m) => m.role === "assistant")
		.flatMap((m) => m.blocks.filter((b) => b.type === "tool_use"))
		.map((b) => b.callId)
		.sort();
	const tools = msgs.filter((m) => m.role === "tool").map((m) => m.callId).sort();
	return calls.length === tools.length && calls.every((id, i) => id === tools[i]);
};

describe("R-E 0.1.44 — the healing fixtures (the three poisoned real sessions)", () => {
	for (const id of SESSIONS) {
		it(`${id}: load → project is pair-clean — the poison heals retroactively`, () => {
			const lines = readFileSync(join(FIXTURE_DIR.pathname, `${id}.jsonl`), "utf8")
				.split("\n")
				.filter(Boolean);
			const events = lines.map((line) => JSON.parse(line).event);
			expect(events.length).toBeGreaterThan(0);
			const msgs = projectMessages(events);
			expect(pairClosed(msgs)).toBe(true);
		});
	}
});
