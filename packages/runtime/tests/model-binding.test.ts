/**
 * PH-1a — the atomic ModelBinding (finding PH-F8, P0).
 *
 * /model's switch used to be three separate writes: setAdapter swapped
 * the adapter, the CLI's setAgentModel repainted the STATUS ROW, and the
 * session's frozen #config kept the old model and provider — so the UI
 * claimed the new model while every subsequent request carried the OLD
 * model id to the NEW adapter, and usage canonicalization kept the old
 * route. The fix is one atomic switch: adapter + model + provider
 * (route) replaced together, effective at the next run like setAdapter
 * always was. (The context window joins the binding when per-model
 * metadata exists — the PH-1c registry; today there is no per-profile
 * window to switch to.)
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter, AdapterEvent, StreamOptions } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

/** An adapter that records the StreamOptions it was called with and
 *  completes a minimal valid turn (text + stop). */
function recordingAdapter(label: string, calls: { label: string; model: string }[]): Adapter {
	return {
		stream(options: StreamOptions): AsyncIterable<AdapterEvent> {
			calls.push({ label, model: options.model });
			return (async function* () {
				yield { type: "text_delta", text: "ok" } as AdapterEvent;
				yield { type: "stop", reason: "end_turn" } as AdapterEvent;
			})();
		},
	};
}

describe("AgentSession.setModelBinding (PH-F8)", () => {
	it("the switch is atomic: the NEXT run sends the new model to the new adapter, and the route follows", async () => {
		const calls: { label: string; model: string }[] = [];
		const dir = mkdtempSync(join(tmpdir(), "kiso-binding-"));
		const store = new SessionStore(dir);
		const agent = createAgent({
			model: "old-model",
			provider: "openai-compat",
			store,
			tools: [],
			adapter: recordingAdapter("A", calls),
		});
		const session = await agent.session({ id: "s" });

		// turn 1 — the startup binding: adapter A, old-model.
		for await (const _ of session.run("first")) {
			// drain
		}
		expect(calls).toEqual([{ label: "A", model: "old-model" }]);
		expect(session.provider).toBe("openai-compat");

		// the /model switch — ONE call, everything moves together.
		session.setModelBinding({
			adapter: recordingAdapter("B", calls),
			model: "new-model",
			provider: "anthropic",
		});

		// turn 2 — the new adapter must receive the NEW model id, and the
		// session's route identity must follow (usage canonicalization and
		// the trace provenance key on it).
		for await (const _ of session.run("second")) {
			// drain
		}
		expect(calls[1]).toEqual({ label: "B", model: "new-model" });
		expect(session.provider).toBe("anthropic");
	});

	it("omitting provider clears the route — an unknown binding is honest (route null-priced), never the stale one", async () => {
		const calls: { label: string; model: string }[] = [];
		const dir = mkdtempSync(join(tmpdir(), "kiso-binding-"));
		const store = new SessionStore(dir);
		const agent = createAgent({
			model: "old-model",
			provider: "anthropic",
			store,
			tools: [],
			adapter: recordingAdapter("A", calls),
		});
		const session = await agent.session({ id: "s" });
		session.setModelBinding({ adapter: recordingAdapter("B", calls), model: "mystery" });
		expect(session.provider).toBeUndefined();
	});

	it("setAdapter alone keeps the binding — the faux re-arm path (same model, new adapter instance)", async () => {
		const calls: { label: string; model: string }[] = [];
		const dir = mkdtempSync(join(tmpdir(), "kiso-binding-"));
		const store = new SessionStore(dir);
		const agent = createAgent({
			model: "m1",
			provider: "openai-compat",
			store,
			tools: [],
			adapter: recordingAdapter("A", calls),
		});
		const session = await agent.session({ id: "s" });
		session.setAdapter(recordingAdapter("A2", calls));
		for await (const _ of session.run("go")) {
			// drain
		}
		expect(calls[0]).toEqual({ label: "A2", model: "m1" });
		expect(session.provider).toBe("openai-compat");
	});
});
