/**
 * PH-1c.1 — Anthropic prompt caching, opt-in (finding PH-F13).
 *
 * The adapter READ the cache counters from day one but never SENT a
 * cache_control breakpoint — Anthropic users never got a cache hit.
 * The fix is endpoint-aware by construction (this adapter IS the
 * anthropic dialect) and OFF by default: injecting breakpoints changes
 * the request bytes, and a cost behavior does not flip silently — the
 * default flips only after the paired bench proves it at a release.
 *
 * The two wire shapes pinned here:
 *  OFF (default): the request is BYTE-IDENTICAL to the pre-PH-1c.1
 *    adapter — system stays a plain string, no cache_control anywhere.
 *  ON: the system prompt becomes ONE text block carrying
 *    cache_control ephemeral, and the LAST message's LAST content
 *    block carries the rolling conversation breakpoint.
 */

import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { Adapter, StreamOptions } from "@vincemakes/kiso-core";
import { createAnthropicAdapter } from "@vincemakes/kiso-provider-anthropic";

function fakeAnthropic(onCreate: (p: unknown) => void): Anthropic {
	return {
		messages: {
			stream: (p: unknown) => {
				onCreate(p);
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "message_start", message: { usage: { input_tokens: 1 } } };
						yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } };
						yield { type: "message_stop" };
					},
				};
			},
		},
	} as unknown as Anthropic;
}

async function drain(adapter: Adapter, opts: StreamOptions): Promise<void> {
	for await (const _ of adapter.stream(opts)) {
		// drain
	}
}

const OPTS: StreamOptions = {
	model: "claude-sonnet-5",
	systemPrompt: "the system prompt",
	messages: [
		{ role: "user", content: "first" },
		{ role: "assistant", blocks: [{ type: "text", text: "reply" }] },
		{ role: "user", content: "second" },
	],
};

describe("PH-1c.1 — cache_control is OFF by default (byte-identical wire)", () => {
	it("no opts: system is a plain string and NO cache_control appears anywhere", async () => {
		let seen: unknown;
		await drain(createAnthropicAdapter(fakeAnthropic((p) => (seen = p))), OPTS);
		const p = seen as { system?: unknown };
		expect(typeof p.system).toBe("string");
		expect(JSON.stringify(seen)).not.toContain("cache_control");
	});
});

describe("PH-1c.1 — cache_control ON places exactly two breakpoints", () => {
	it("the system block and the LAST message's LAST block carry ephemeral cache_control", async () => {
		let seen: unknown;
		await drain(createAnthropicAdapter(fakeAnthropic((p) => (seen = p)), { promptCaching: true }), OPTS);
		const p = seen as {
			system?: { type: string; text: string; cache_control?: { type: string } }[];
			messages: { content: unknown }[];
		};
		expect(Array.isArray(p.system)).toBe(true);
		expect(p.system![0]).toMatchObject({ type: "text", text: "the system prompt", cache_control: { type: "ephemeral" } });
		const last = p.messages[p.messages.length - 1]!;
		const blocks = last.content as { type: string; cache_control?: { type: string } }[];
		expect(Array.isArray(blocks)).toBe(true);
		expect(blocks[blocks.length - 1]!.cache_control).toEqual({ type: "ephemeral" });
		// exactly TWO breakpoints in the whole request (the 4-slot budget
		// is real; earlier messages carry none)
		expect(JSON.stringify(seen).split('"cache_control"').length - 1).toBe(2);
	});

	it("ON with no system prompt: only the message breakpoint appears", async () => {
		let seen: unknown;
		const { systemPrompt: _omit, ...noSystem } = OPTS;
		await drain(createAnthropicAdapter(fakeAnthropic((p) => (seen = p)), { promptCaching: true }), noSystem);
		expect(JSON.stringify(seen).split('"cache_control"').length - 1).toBe(1);
	});
});
