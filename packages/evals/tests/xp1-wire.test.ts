/**
 * XP-1 — the resolved reasoning setting on the wire (the ratified spec's
 * dialect mappings, each sourced at freeze):
 *
 *  openai-chat (DeepSeek V4): top-level `thinking: {type}` plus
 *    `reasoning_effort` (the thinking-mode guide, read 2026-08-26).
 *  anthropic-messages: `output_config: {effort}` (the effort doc, read
 *    2026-08-26). The Anthropic thinking-mode WIRE is deliberately not
 *    serialized yet: the registry carries no sourced mode list for the
 *    entered models, so no valid selection can produce one — nothing is
 *    guessed.
 *
 * The byte anchor both ways: an ABSENT reasoning option adds NO key —
 * default-profile sessions stay byte-identical to pre-XP-1 requests.
 *
 * RED on the pre-XP-1 tree: StreamOptions has no reasoning field and no
 * adapter serializes one.
 */

import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { createAnthropicAdapter } from "@vincemakes/kiso-provider-anthropic";
import { createOpenAICompatAdapter } from "@vincemakes/kiso-provider-openai";

function fakeOpenAI(params: { onCreate?: (p: unknown) => void }) {
	return {
		chat: {
			completions: {
				create: async (p: unknown) => {
					params.onCreate?.(p);
					return { async *[Symbol.asyncIterator]() {} };
				},
			},
		},
	} as unknown as OpenAI;
}

function fakeAnthropic(params: { onCreate?: (p: unknown) => void }) {
	return {
		messages: {
			stream: (p: unknown) => {
				params.onCreate?.(p);
				return { async *[Symbol.asyncIterator]() {} };
			},
		},
	} as unknown as Anthropic;
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
	for await (const _ of stream) {
		// drained
	}
}

describe("XP-1 — openai-chat wire (DeepSeek V4 shape)", () => {
	it("a resolved setting serializes as thinking:{type} + reasoning_effort", async () => {
		let captured: Record<string, unknown> = {};
		const adapter = createOpenAICompatAdapter(fakeOpenAI({ onCreate: (p) => (captured = p as Record<string, unknown>) }));
		await drain(
			adapter.stream({
				model: "deepseek-v4-flash",
				messages: [{ role: "user", content: "go" }],
				reasoning: { thinking: "enabled", effort: "high" },
			}),
		);
		expect(captured.thinking).toEqual({ type: "enabled" });
		expect(captured.reasoning_effort).toBe("high");
	});

	it("effort alone serializes alone; ABSENT reasoning adds NO key (the byte anchor)", async () => {
		let captured: Record<string, unknown> = {};
		const adapter = createOpenAICompatAdapter(fakeOpenAI({ onCreate: (p) => (captured = p as Record<string, unknown>) }));
		await drain(
			adapter.stream({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "go" }], reasoning: { effort: "max" } }),
		);
		expect(captured.reasoning_effort).toBe("max");
		expect("thinking" in captured).toBe(false);

		await drain(adapter.stream({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "go" }] }));
		expect("reasoning_effort" in captured).toBe(false);
		expect("thinking" in captured).toBe(false);
	});
});

describe("XP-1 — anthropic-messages wire", () => {
	it("effort serializes as output_config.effort; ABSENT adds no key", async () => {
		let captured: Record<string, unknown> = {};
		const adapter = createAnthropicAdapter(fakeAnthropic({ onCreate: (p) => (captured = p as Record<string, unknown>) }));
		await drain(
			adapter.stream({ model: "claude-sonnet-5", messages: [{ role: "user", content: "go" }], reasoning: { effort: "xhigh" } }),
		);
		expect(captured.output_config).toEqual({ effort: "xhigh" });

		await drain(adapter.stream({ model: "claude-sonnet-5", messages: [{ role: "user", content: "go" }] }));
		expect("output_config" in captured).toBe(false);
	});
});
