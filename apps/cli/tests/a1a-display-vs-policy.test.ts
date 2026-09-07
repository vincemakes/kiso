/**
 * A1a (R2.2) — the status line's headroom counts the parts; the
 * auto-compact policy keeps its own number. Same session: the displayed
 * ratio is the request budget (system + tools + messages + continuations
 * + reserve), the policy's ratio is the old messages-only estimate — and
 * the two differ whenever a tool table exists, which is always. The
 * policy's input is nameable (`autoCompactRatio`) so this gate can pin
 * that it did NOT move this round.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Adapter, type AdapterEvent } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { autoCompactRatio, displayCtxRatio, estimateCtxRatio } from "../src/chat.js";

const adapter = {
	stream: async function* (): AsyncIterable<AdapterEvent> {
		yield { type: "stop", reason: "end_turn", seq: 0 } as unknown as AdapterEvent;
	},
} as unknown as Adapter;

describe("A1a — display counts the parts, the policy does not move", () => {
	it("the same session: displayed headroom is smaller than the messages-only ratio implies; the policy reads the old number", async () => {
		const tools = Array.from({ length: 30 }, (_, i) =>
			defineTool({ name: `tool_${i}`, description: "d".repeat(300), parameters: { type: "object", properties: { a: { type: "string", description: "e".repeat(200) } } }, execute: async () => ({ content: "", isError: false }) }),
		);
		const agent = createAgent({ model: "faux", store: new SessionStore(mkdtempSync(join(tmpdir(), "kiso-a1a-"))), tools, adapter, systemPrompt: "s".repeat(4000) });
		const session = await agent.session({ id: "a1a-display" });
		const policy = estimateCtxRatio(session);
		const display = displayCtxRatio(session);
		expect(display).toBeGreaterThan(policy); // the tool table and the system prompt are real
		expect(autoCompactRatio(session)).toBe(policy); // the policy's input is the old estimate, unchanged
	});
});
