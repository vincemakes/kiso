/**
 * #20 — finish_reason "tool_calls" with zero tool calls and substantive text.
 *
 * A compat route answered in prose and labelled the finish "tool_calls"
 * while sending no call. The adapter mapped the label alone to
 * `stop { reason: "tool_use" }`; the kernel then waited on calls that never
 * existed and the run ended as a failure although the answer was on the
 * screen. The adapter now decides by its OWN wire state: no pending call
 * and some non-blank text in this attempt is an `end_turn`. A real call
 * stays `tool_use`; an empty reply stays `tool_use` too, so the kernel's
 * Area-6 rule still makes it an invalid request (never a laundered
 * success). The flags belong to one attempt: a retry starts clean.
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterEvent } from "@vincemakes/kiso-core";
import { createOpenAICompatProvider } from "../src/index.js";

const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const chunk = (extra: Record<string, unknown>): string => sse({ id: "c", object: "chat.completion.chunk", model: "m", ...extra });
const text = (t: string) => chunk({ choices: [{ index: 0, delta: { content: t } }] });
const finish = (fr: string) => chunk({ choices: [{ index: 0, delta: {}, finish_reason: fr }] });

let server: Server | undefined;
afterEach(async () => {
	if (server !== undefined) await new Promise<void>((r) => server!.close(() => r()));
	server = undefined;
});

/** One server, one scripted body per request (a retry is the next body). */
async function adapterOver(bodies: string[][]) {
	let n = 0;
	server = createServer((req, res) => {
		req.resume();
		const body = bodies[Math.min(n++, bodies.length - 1)]!;
		res.writeHead(200, { "content-type": "text/event-stream" });
		for (const b of body) res.write(b);
		// a body without a finish ends the stream with no [DONE] marker either
		if (body.some((b) => b.includes("finish_reason"))) res.write("data: [DONE]\n\n");
		res.end();
	});
	await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	return createOpenAICompatProvider({ apiKey: "rig", baseUrl: `http://127.0.0.1:${port}/v1` });
}

async function attempt(adapter: Awaited<ReturnType<typeof adapterOver>>): Promise<{ events: AdapterEvent[]; error?: unknown }> {
	const events: AdapterEvent[] = [];
	try {
		for await (const ev of adapter.stream({ model: "m", messages: [{ role: "user", content: "go" }] })) events.push(ev);
	} catch (error) {
		return { events, error };
	}
	return { events };
}

const stopOf = (events: AdapterEvent[]) => events.filter((e) => e.type === "stop").map((e) => (e as { reason: string }).reason);
const ends = (events: AdapterEvent[]) => events.filter((e) => e.type === "tool_call_end");

describe("#20 — finish_reason tool_calls with no tool call", () => {
	it("text, then tool_calls with no call, is an end_turn", async () => {
		const a = await adapterOver([[text("The answer is 42."), finish("tool_calls")]]);
		const { events } = await attempt(a);
		expect(ends(events)).toHaveLength(0);
		expect(stopOf(events)).toEqual(["end_turn"]);
	});

	it("a real call with tool_calls stays tool_use (text beside it changes nothing)", async () => {
		const a = await adapterOver([
			[
				text("Let me look."),
				chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] } }] }),
				finish("tool_calls"),
			],
		]);
		const { events } = await attempt(a);
		expect(ends(events)).toHaveLength(1);
		expect(stopOf(events)).toEqual(["tool_use"]);
	});

	it("a call whose id never arrives still counts as a call (no start, an end)", async () => {
		const a = await adapterOver([
			[
				text("Reading."),
				chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: "function", function: { name: "read", arguments: "{}" } }] } }] }),
				finish("tool_calls"),
			],
		]);
		const { events } = await attempt(a);
		expect(events.some((e) => e.type === "tool_call_start")).toBe(false);
		expect(ends(events)).toHaveLength(1);
		expect(stopOf(events)).toEqual(["tool_use"]);
	});

	it("no text (or only whitespace) and no call stays tool_use, so the kernel still refuses it", async () => {
		for (const body of [[finish("tool_calls")], [text("  \n\t"), finish("tool_calls")]]) {
			const a = await adapterOver([body]);
			const { events } = await attempt(a);
			expect(stopOf(events)).toEqual(["tool_use"]);
			await new Promise<void>((r) => server!.close(() => r()));
			server = undefined;
		}
	});

	it("the flags belong to one attempt: text in a failed attempt does not carry into the retry", async () => {
		const a = await adapterOver([
			// attempt 1: text, then the stream ends with no finish (a retryable stream failure)
			[text("partial answer")],
			// attempt 2: no text, tool_calls, no call
			[finish("tool_calls")],
		]);
		const first = await attempt(a);
		expect(first.error).toBeDefined();
		expect(stopOf(first.events)).toEqual([]);
		const second = await attempt(a);
		expect(second.error).toBeUndefined();
		expect(stopOf(second.events)).toEqual(["tool_use"]);
	});

	it("a plain stop is still end_turn, and other finish reasons are untouched", async () => {
		const a = await adapterOver([[text("done"), finish("stop")]]);
		expect(stopOf((await attempt(a)).events)).toEqual(["end_turn"]);
	});
});
