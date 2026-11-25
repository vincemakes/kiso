/**
 * 0.40.0 — a person's skill turn: `run(content, { via })` records HOW the
 * turn was composed next to WHAT the model received. The model's request
 * is the content alone — byte-identical to the same content typed by hand —
 * and the session is named by the line the person typed, not by the first
 * line of a SKILL.md they never wrote.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import type { Adapter, Event } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { sessionTitle } from "../src/store.js";

const BODY = "Review the diff for correctness.\n\nsrc/a.ts";
const via = { kind: "skill" as const, name: "review", line: "/review src/a.ts" };

/** One turn through a faux adapter that remembers every request's messages. */
async function oneTurn(withVia: boolean): Promise<{ requests: string[]; events: Event[]; dir: string }> {
	const dir = mkdtempSync(join(tmpdir(), "kiso-skill-via-"));
	const store = new SessionStore(dir);
	const script: FauxScript = [{ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] }];
	const faux = createFauxProvider(script);
	const requests: string[] = [];
	const adapter: Adapter = {
		stream(options) {
			requests.push(JSON.stringify(options.messages));
			return faux.stream(options);
		},
	};
	const session = await createAgent({ model: "faux", store, tools: [], adapter }).session({ id: "s" });
	for await (const _ of session.run(BODY, withVia ? { source: "user", via } : { source: "user" })) {
		/* drain */
	}
	await store.closeAll();
	return { requests, events: new SessionStore(dir).load("s").map((r) => r.event), dir };
}

describe("0.40.0 — user_input.via", () => {
	it("persists durably beside source, and survives a reload", async () => {
		const { events } = await oneTurn(true);
		const input = events.find((e): e is Event & { type: "user_input" } => e.type === "user_input");
		expect(input?.content).toBe(BODY);
		expect(input?.source).toBe("user");
		expect(input?.via).toEqual(via);
	});

	it("the model's request is byte-identical to the same content typed by hand", async () => {
		const skill = await oneTurn(true);
		const typed = await oneTurn(false);
		expect(skill.requests).toHaveLength(1);
		expect(skill.requests).toEqual(typed.requests);
		expect(skill.requests[0]).not.toContain("/review");
	});

	it("the session is named by the typed line, not the SKILL.md body", async () => {
		const { events } = await oneTurn(true);
		expect(sessionTitle(events.map((event) => ({ runId: "", ts: 0, event })))).toBe("/review src/a.ts");
	});
});
