/**
 * B1 — a host can start a NEW session at a chosen reasoning setting
 * (kiso-doc plan-gpt-reasoning-summary-and-default-effort-2026-09-28.md).
 *
 * `AgentDefinition.reasoning` is a new session's initial binding and
 * nothing else: it is recorded in the session's first profile revision, so
 * a resume restores it; a session that already has a recorded profile keeps
 * its own; setModelBinding stays the one way to change a live binding.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter, AdapterEvent } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { readProfile } from "../src/internal.js";

const answering: Adapter = {
	stream: async function* (): AsyncIterable<AdapterEvent> {
		yield { seq: 0, type: "text_delta", text: "ok" };
		yield { seq: 0, type: "stop", reason: "end_turn" };
	},
};
const HIGH = { thinking: "default", effort: "high" } as const;
const LOW = { thinking: "default", effort: "low" } as const;

async function oneTurn(dir: string, reasoning?: typeof HIGH | typeof LOW): Promise<{ reasoning: unknown }> {
	const agent = createAgent({ model: "faux", store: new SessionStore(dir), tools: [], adapter: answering, ...(reasoning !== undefined ? { reasoning } : {}) });
	const session = await agent.session({ id: "s" });
	for await (const _ of session.run("go")) void _;
	const r = { reasoning: session.reasoning };
	agent.close();
	return r;
}

describe("AgentDefinition.reasoning — a new session's initial binding", () => {
	it("a new session starts at it, and its first profile revision records it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-b1-"));
		expect((await oneTurn(dir, HIGH)).reasoning).toEqual(HIGH);
		const profile = readProfile(dir, "s");
		expect(profile.kind === "ok" ? profile.profile.reasoning : profile).toEqual(HIGH);
	});

	it("a resumed session keeps the reasoning it recorded, whatever the definition says", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-b1-"));
		await oneTurn(dir, HIGH);
		expect((await oneTurn(dir, LOW)).reasoning).toEqual(HIGH);
	});

	it("without it, a new session starts at default/default (guard)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-b1-"));
		expect((await oneTurn(dir)).reasoning).toEqual({ thinking: "default", effort: "default" });
	});
});
