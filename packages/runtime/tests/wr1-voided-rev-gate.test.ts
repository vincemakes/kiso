/**
 * WR-1A ④b — the EC-1 coherence gate, named after the v1→v2 adjudication
 * reason itself: A VOIDED TURN'S REVISION IS UNCITEABLE BY CONSTRUCTION.
 *
 * The scenario the hidden ledger got wrong: a precommit-safe read
 * physically EXECUTES (its durable receipt carries `[rev: R]`), but the
 * model turn it belongs to never commits (no stop — the draft dies).
 * v1 would have remembered R in process memory and honored it later.
 * v2's claim is stronger: after recovery disposes of the draft, the
 * NEXT model request's projection must not contain R at all — an
 * observation that never entered the committed trajectory cannot become
 * authority for a future mutation.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { projectMessages, type Event } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

const DONE: FauxScript = [{ events: [{ type: "stop", reason: "end_turn" }] }];
const TOKEN = "rev:aaaabbbbccccdddd";

describe("WR-1A ④b — a voided turn's revision is unciteable by construction", () => {
	it("the draft's precommit read receipt carries [rev: …]; after recovery the projection contains NO trace of it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-wr1a-void-"));
		const seed: readonly Event[] = [
			{ seq: 0, type: "user_input", content: "look at f.ts" },
			{ seq: 1, type: "text_delta", text: "let me read it" },
			{ seq: 2, type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "f.ts" } },
			{ seq: 3, type: "tool_execution_started", executionId: "ex1", callId: "c1", name: "read_file", input: { path: "f.ts" } },
			{ seq: 4, type: "tool_execution_succeeded", executionId: "ex1", callId: "c1", result: { content: `hello\n[rev: ${TOKEN}]`, isError: false } },
			// NO stop — the stream died mid-draft; the turn never committed.
		] as unknown as readonly Event[];
		const store = new SessionStore(dir);
		for (const ev of seed) await store.append("s", "r1", ev);
		store.closeAll();

		const live = new SessionStore(dir);
		const session = await createAgent({ model: "faux", store: live, tools: [], adapter: createFauxProvider(DONE) }).session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.resume()) events.push(ev);
		live.closeAll();

		// What the NEXT model request would see: the projection of the
		// post-recovery durable log. The voided draft's revision must be
		// absent from every message — not the call, not a repaired result.
		const finalLog = new SessionStore(dir).load("s").map((r) => r.event);
		const projected = JSON.stringify(projectMessages(finalLog));
		expect(projected).not.toContain(TOKEN);
	});
});
