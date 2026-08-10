/**
 * R-E 0.1.43 — Gap B RED (the uncommitted draft): a tail of model output
 * whose stop never landed.
 *
 * The durable shape a SIGKILL mid-stream leaves: the draft's text_delta
 * events are persisted, the stop never is. On resume the projection
 * flushAssistant commits the truncated draft as a COMPLETE assistant
 * message (kernel/project.ts — the stop is invisible to the projection),
 * the model is asked to continue FROM it, and the new output's deltas
 * land in the log WITHOUT any boundary between the draft and them (the
 * live loop never emits assistant_start/assistant_end) — the projection
 * merges both into ONE assistant message: the new answer glued onto
 * the draft.
 *
 * RED (today): the resumed provider request carries the draft as
 * committed assistant history; the final projection contains ONE
 * assistant message with the draft AND the new output. GREEN (the fix):
 * the resume appends the abandon marker first — "a model output suffix
 * without a committed stop is an incomplete draft and must never become
 * committed provider history" — the draft is voided, never enters the
 * provider projection, and the new output renders alone: draft A voided,
 * output B valid, purely derivable from the log.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectMessages, type Adapter, type Event, type Message } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

describe("R-E 0.1.43 Gap B (RED): an un-stopped tail draft", () => {
	it("resume never commits the draft to provider history and never merges it with the new output", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-gb-red-"));
		const store = new SessionStore(dir);
		// The durable shape a SIGKILL mid-stream leaves: the draft's deltas
		// persisted, the stop never landed.
		await store.append("s", "r1", { seq: 0, type: "user_input", content: "go" });
		await store.append("s", "r1", { seq: 1, type: "text_delta", text: "the draft answer begins" });
		await store.append("s", "r1", { seq: 2, type: "text_delta", text: " and continues" });
		store.closeAll();

		// The provider captures every request and serves one fresh turn.
		const requests: Message[][] = [];
		const adapter: Adapter = {
			stream(options) {
				requests.push(options.messages as Message[]);
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "text_delta", text: "FRESH OUTPUT", seq: 0 };
						yield { type: "stop", reason: "end_turn", seq: 1 };
					},
				};
			},
		};
		const agent = createAgent({ model: "faux", store: new SessionStore(dir), tools: [], adapter });
		const session = await agent.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.resume()) events.push(ev);

		// GREEN 1: the provider was NOT asked to continue FROM the draft —
		// the draft is not committed history.
		expect(requests[0]).toBeDefined();
		const draftAsHistory = requests[0]!.some(
			(m) => m.role === "assistant" && JSON.stringify(m).includes("the draft answer begins"),
		);
		expect(draftAsHistory).toBe(false);

		// GREEN 2: the final projection does NOT glue the new output onto
		// the draft — no single assistant message carries both.
		const records = new SessionStore(dir).load("s");
		const projected = projectMessages(records.map((r) => r.event));
		const merged = projected.some(
			(m) =>
				m.role === "assistant" &&
				JSON.stringify(m).includes("the draft answer begins") &&
				JSON.stringify(m).includes("FRESH OUTPUT"),
		);
		expect(merged).toBe(false);

		// GREEN 3: the new output IS valid committed history, and the run
		// completed.
		expect(projected.some((m) => m.role === "assistant" && JSON.stringify(m).includes("FRESH OUTPUT"))).toBe(true);
		expect(events.find((e) => e.type === "terminal")?.outcome.kind).toBe("completed");
	});
});
