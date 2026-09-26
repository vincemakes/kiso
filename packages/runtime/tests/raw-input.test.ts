/**
 * 0.43.0 (#13, 0420-F1) — the lexical arguments and the ToolContext
 * invariant.
 *
 * ToolContext is a function of the durable invocation and execution,
 * never of whether the execution happened fresh or after recovery. The
 * handler sees the arguments exactly as the model streamed them
 * (`rawInput`, the lexical companion of the parsed `input`); the
 * projection carries them on the block and encodes them back losslessly;
 * the openai-family adapters replay them verbatim; and the cold-resume
 * EXECUTE path hands the handler the SAME context the fresh path did on
 * the same durable prefix. The first, third and fifth tests are RED on
 * 0.42.x (no rawInput; `{ signal }` alone on resume).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, loop, messagesToEvents, projectMessages, ToolRegistry, type Adapter, type AdapterEvent, type Event, type Message, type ToolContext } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

/** A model that streams one call's arguments in two lexical pieces, then answers. */
function streamingModel(pieces: readonly string[] | null): Adapter {
	let n = 0;
	return {
		stream: async function* (): AsyncIterable<AdapterEvent> {
			n += 1;
			if (n === 1) {
				yield { seq: 0, type: "tool_call_start", callId: "c1", name: "probe" };
				for (const p of pieces ?? []) yield { seq: 0, type: "tool_call_input_delta", callId: "c1", inputJsonDelta: p };
				yield { seq: 0, type: "tool_call_end", callId: "c1", name: "probe", input: { x: 5 } };
				yield { seq: 0, type: "stop", reason: "tool_use" };
			} else {
				yield { seq: 0, type: "text_delta", text: "done" };
				yield { seq: 0, type: "stop", reason: "end_turn" };
			}
		},
	};
}

const seen: { input: unknown; ctx: ToolContext }[] = [];
const probe = defineTool({
	name: "probe",
	description: "records what the handler was handed",
	parameters: { type: "object", properties: { x: { type: "number" } } },
	execute: async (input, ctx) => {
		seen.push({ input, ctx });
		return { content: "ok", isError: false };
	},
});

const ctxShape = (c: ToolContext) => ({ sessionId: c.sessionId, callId: c.callId, rawInput: c.rawInput, keys: Object.keys(c).sort() });
/** The execution id the path WROTE — the handler's executionId must be that event's, on either path. */
const startedIdOf = (events: readonly Event[]) => (events.find((e) => e.type === "tool_execution_started") as (Event & { type: "tool_execution_started" }) | undefined)?.executionId;

describe("0.43.0: the handler sees the lexical arguments beside the parsed input", () => {
	it("two deltas `{\"x\":5.` + `0}` → ctx.rawInput is the exact text; input.x is the parsed 5", async () => {
		seen.length = 0;
		const registry = new ToolRegistry();
		registry.register(probe);
		for await (const _ of loop({ adapter: streamingModel(['{"x":5.', "0}"]), model: "m", registry, messages: [{ role: "user", content: "go" }], maxRetries: 0, sessionId: "s" })) void _;
		expect(seen).toHaveLength(1);
		expect(seen[0]!.ctx.rawInput).toBe('{"x":5.0}');
		expect((seen[0]!.input as { x: number }).x).toBe(5);
		expect(seen[0]!.ctx.callId).toBe("c1");
		expect(seen[0]!.ctx.executionId).toMatch(/^ex-\d+$/);
	});

	it("no delta streamed → rawInput is ABSENT (not \"\"); a single empty delta → present and \"\"", async () => {
		seen.length = 0;
		const registry = new ToolRegistry();
		registry.register(probe);
		for await (const _ of loop({ adapter: streamingModel(null), model: "m", registry, messages: [{ role: "user", content: "go" }], maxRetries: 0 })) void _;
		expect("rawInput" in seen[0]!.ctx).toBe(false);
		seen.length = 0;
		for await (const _ of loop({ adapter: streamingModel([""]), model: "m", registry, messages: [{ role: "user", content: "go" }], maxRetries: 0 })) void _;
		expect(seen[0]!.ctx.rawInput).toBe("");
	});
});

describe("0.43.0: the projection carries rawInput on the block, and encodes it back losslessly", () => {
	const events: Event[] = [
		{ seq: 1, type: "user_input", content: "go" },
		{ seq: 2, type: "tool_call_start", callId: "c1", name: "probe" },
		{ seq: 3, type: "tool_call_input_delta", callId: "c1", inputJsonDelta: '{"x":5.' },
		{ seq: 4, type: "tool_call_input_delta", callId: "c1", inputJsonDelta: "0}" },
		{ seq: 5, type: "tool_call_end", callId: "c1", name: "probe", input: { x: 5 } },
		{ seq: 6, type: "stop", reason: "tool_use" },
		{ seq: 7, type: "tool_result", callId: "c1", content: "ok", isError: false },
	] as Event[];

	it("the block has rawInput exactly; a call without deltas has none", () => {
		const msgs = projectMessages(events);
		const block = (msgs[1] as { blocks: readonly { type: string; rawInput?: string; input: unknown }[] }).blocks.find((b) => b.type === "tool_use")!;
		expect(block.rawInput).toBe('{"x":5.0}');
		expect(block.input).toEqual({ x: 5 });
		const bare = projectMessages(events.filter((e) => e.type !== "tool_call_input_delta"));
		const b2 = (bare[1] as { blocks: readonly { type: string; rawInput?: string }[] }).blocks.find((b) => b.type === "tool_use")!;
		expect("rawInput" in b2).toBe(false);
	});

	it("Message → Events → Message keeps rawInput; a block without it encodes no delta", () => {
		const msgs = projectMessages(events);
		const back = projectMessages(messagesToEvents(msgs).map((e, i) => ({ ...e, seq: i + 1 })) as Event[]);
		expect(back).toEqual(msgs);
		const encoded = messagesToEvents(msgs);
		expect(encoded.filter((e) => e.type === "tool_call_input_delta")).toHaveLength(1);
		const withoutRaw: Message[] = msgs.map((m) => (m.role === "assistant" ? { ...m, blocks: m.blocks.map((b) => (b.type === "tool_use" ? { type: b.type, callId: b.callId, name: b.name, input: b.input } : b)) } : m)) as Message[];
		expect(messagesToEvents(withoutRaw).filter((e) => e.type === "tool_call_input_delta")).toHaveLength(0);
	});
});

describe("0.43.0: a callId re-used by a later invocation inherits nothing (the buffer is consumed at the call's end)", () => {
	it("projection: the first call streamed deltas, the second (same callId, no start, no delta) has no rawInput", () => {
		const events = [
			{ seq: 1, type: "user_input", content: "go" },
			{ seq: 2, type: "tool_call_start", callId: "call_0", name: "probe" },
			{ seq: 3, type: "tool_call_input_delta", callId: "call_0", inputJsonDelta: '{"x":5.0}' },
			{ seq: 4, type: "tool_call_end", callId: "call_0", name: "probe", input: { x: 5 } },
			{ seq: 5, type: "stop", reason: "tool_use" },
			{ seq: 6, type: "tool_result", callId: "call_0", content: "ok", isError: false },
			// the provider's no-id fallback: an end with no start and no delta, the same callId
			{ seq: 7, type: "tool_call_end", callId: "call_0", name: "probe", input: { x: 6 } },
			{ seq: 8, type: "stop", reason: "tool_use" },
			{ seq: 9, type: "tool_result", callId: "call_0", content: "ok", isError: false },
		] as Event[];
		const blocks = projectMessages(events).filter((m) => m.role === "assistant").map((m) => (m as { blocks: readonly { type: string; rawInput?: string }[] }).blocks.find((b) => b.type === "tool_use")!);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]!.rawInput).toBe('{"x":5.0}');
		expect("rawInput" in blocks[1]!, "the second invocation must not inherit the first's text").toBe(false);
	});

	it("kernel: the same across two attempts — a second call under a re-used callId with no delta hands the handler no rawInput", async () => {
		seen.length = 0;
		let n = 0;
		const adapter: Adapter = {
			stream: async function* (): AsyncIterable<AdapterEvent> {
				n += 1;
				if (n === 1) {
					yield { seq: 0, type: "tool_call_start", callId: "call_0", name: "probe" };
					yield { seq: 0, type: "tool_call_input_delta", callId: "call_0", inputJsonDelta: '{"x":5.0}' };
					yield { seq: 0, type: "tool_call_end", callId: "call_0", name: "probe", input: { x: 5 } };
					yield { seq: 0, type: "stop", reason: "tool_use" };
				} else if (n === 2) {
					yield { seq: 0, type: "tool_call_end", callId: "call_0", name: "probe", input: { x: 6 } };
					yield { seq: 0, type: "stop", reason: "tool_use" };
				} else {
					yield { seq: 0, type: "text_delta", text: "done" };
					yield { seq: 0, type: "stop", reason: "end_turn" };
				}
			},
		};
		const registry = new ToolRegistry();
		registry.register(probe);
		for await (const _ of loop({ adapter, model: "m", registry, messages: [{ role: "user", content: "go" }], maxRetries: 0 })) void _;
		expect(seen).toHaveLength(2);
		expect(seen[0]!.ctx.rawInput).toBe('{"x":5.0}');
		expect("rawInput" in seen[1]!.ctx).toBe(false);
	});
});

describe("0.43.0 (0420-F1): ToolContext is derived from the durable invocation and execution, never from ephemeral process state", () => {
	it("a committed call on disk, no execution → the cold-resume handler gets the fresh path's context on the same prefix", async () => {
		// the fresh path, recorded
		seen.length = 0;
		const dirA = mkdtempSync(join(tmpdir(), "kiso-raw-fresh-"));
		const storeA = new SessionStore(dirA);
		const agentA = createAgent({ model: "faux", store: storeA, tools: [probe], adapter: streamingModel(['{"x":5.', "0}"]) });
		const sessionA = await agentA.session({ id: "s" });
		for await (const _ of sessionA.run("go")) void _;
		expect(seen).toHaveLength(1);
		const fresh = ctxShape(seen[0]!.ctx);
		expect(fresh.rawInput).toBe('{"x":5.0}');
		expect(fresh.sessionId).toBe("s");
		const logA = [...sessionA.log.all];
		expect(seen[0]!.ctx.executionId).toBe(startedIdOf(logA)); // keyed by the event it wrote
		agentA.close();

		// the same durable prefix, cut before the execution started
		const startedAt = logA.findIndex((e) => e.type === "tool_execution_started");
		expect(startedAt).toBeGreaterThan(0);
		const dirB = mkdtempSync(join(tmpdir(), "kiso-raw-resume-"));
		const seedStore = new SessionStore(dirB);
		for (const e of logA.slice(0, startedAt)) await seedStore.append("s", "r1", e);
		seedStore.closeAll();

		seen.length = 0;
		// a model that only answers — the resume must execute the COMMITTED call, then ask once and stop
		const answering: Adapter = { stream: async function* () { yield { seq: 0, type: "text_delta", text: "done" } as AdapterEvent; yield { seq: 0, type: "stop", reason: "end_turn" } as AdapterEvent; } };
		const agentB = createAgent({ model: "faux", store: new SessionStore(dirB), tools: [probe], adapter: answering });
		const sessionB = await agentB.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of sessionB.resume()) events.push(ev);
		expect(seen, "the resume executed the committed call once").toHaveLength(1);
		expect(ctxShape(seen[0]!.ctx)).toEqual(fresh); // the same invocation context: sessionId, callId, rawInput — and the same key set
		expect(seen[0]!.ctx.executionId).toBe(startedIdOf(events)); // the id of the durable execution THIS path wrote
		// 0430-F1: the two paths now write the same durable history, so the
		// started seqs and the executionIds are equal too — the full invariant.
		expect(seen[0]!.ctx.executionId).toBe(startedIdOf(logA));
		expect(events.find((e) => e.type === "terminal")).toMatchObject({ outcome: { kind: "completed" } });
	});
});
