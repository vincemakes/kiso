/**
 * round 5 — a LIVE tool result keeps everything the handler returned: tags and
 * the full supported content survive the loop, persistence, and the
 * projection — this runs a REAL defineTool'd handler, not a prebuilt
 * Message round-trip.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool, isKisoEvent, type Event } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

const CALL_TURN: FauxScript = [
	{ events: [{ type: "tool_call_end", callId: "c1", name: "sign_off", input: {} }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "stop", reason: "end_turn" }] },
];

function agent(store: SessionStore) {
	return createAgent({
		model: "faux",
		store,
		tools: [
			defineTool({
				name: "sign_off",
				description: "Return a tagged result",
				parameters: { type: "object" },
				execute: async () => ({
					content: "signed",
					isError: false,
					tags: ["do-not-compact", "billing"],
				}),
			}),
		],
		adapter: createFauxProvider(CALL_TURN),
		permissionPolicy: { rules: [{ tool: "sign_off", action: "defer" }] },
	});
}

describe("live tool results (round 5)", () => {
	it("a real Tool's tags survive the loop, the disk, and the projection", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-live-"));
		const store = new SessionStore(dir);
		const session = await agent(store).session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.run("go")) {
			events.push(ev);
			if (ev.type === "permission_requested") await session.approve(ev.decisionId, true);
		}
		// The live stream carries the tags.
		const streamed = events.find(
			(e): e is Event & { type: "tool_result"; tags?: readonly string[]; content: string } =>
				e.type === "tool_result",
		)!;
		expect(streamed.tags).toEqual(["do-not-compact", "billing"]);
		expect(streamed.content).toBe("signed");
		store.closeAll();

		// The DISK record carries them, and passes deep schema validation.
		const store2 = new SessionStore(dir);
		const records = store2.load("s");
		const persisted = records.find((r) => r.event.type === "tool_result");
		expect(persisted).toBeDefined();
		expect(isKisoEvent(persisted!.event)).toBe(true);
		expect((persisted!.event as Event & { tags?: readonly string[] }).tags).toEqual(["do-not-compact", "billing"]);

		// The projection of the reloaded log preserves them losslessly.
		const reloaded = await createAgent({
			model: "faux",
			store: store2,
			tools: [],
			adapter: createFauxProvider([]),
		}).session({ id: "s" });
		const tool = reloaded.projected().find((m) => m.role === "tool");
		expect(tool).toMatchObject({ callId: "c1", content: "signed", isError: false, tags: ["do-not-compact", "billing"] });
	});

	it("a real Tool's tags survive the RESUMED path too", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-live-"));
		const store = new SessionStore(dir);
		const first = await agent(store).session({ id: "s" });
		for await (const ev of first.run("go")) {
			if (ev.type === "permission_requested") break; // pause, then exit
		}
		store.closeAll();

		const store2 = new SessionStore(dir);
		const second = await agent(store2).session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of second.resume()) {
			events.push(ev);
			if (ev.type === "permission_requested") await second.approve(ev.decisionId, true);
		}
		const streamed = events.find(
			(e): e is Event & { type: "tool_result"; tags?: readonly string[] } => e.type === "tool_result",
		)!;
		expect(streamed.tags).toEqual(["do-not-compact", "billing"]);
		expect(events.some((e) => e.type === "terminal")).toBe(true);
	});
});
