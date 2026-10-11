/**
 * PROGRAM research / tool binding (I14) — the FROZEN event format (kiso-doc/design-tool-binding-2026-10-10.md):
 *   tool_execution_started gains two OPTIONAL, additive fields:
 *     binding?: { digest: string }     copied from the tool's own `digest` (the provider computes it; the kernel never hashes)
 *     parent?:  string                 the executionId of the call a CHILD ran under (explicit link)
 *   ToolContext.catalog() entries carry the same optional `digest`.
 * Rules: absent = "binding unknown"; nothing about execution changes when absent; an event without the fields is valid
 * (old logs); an event WITH them passes a reader that ignores unknown keys; a malformed field is rejected.
 */
import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/protocol/adapter.js";
import { isKisoEvent as validateEvent } from "../src/protocol/events.js";
import type { Event } from "../src/protocol/events.js";
import type { Message } from "../src/protocol/messages.js";
import { defineTool, type Tool, type ToolContext, type ToolResult } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { loop } from "../src/kernel/loop.js";
import { seedLog } from "./seed.js";

const USER: Message = { role: "user", content: "go" };
const ok = (c: string): ToolResult => ({ content: c, isError: false });
function turn(calls: { callId: string; name: string }[]): Adapter {
	let phase = 0;
	return { stream: async function* () {
		const events: unknown[] = phase === 0 ? [...calls.map((c, i) => ({ type: "tool_call_end", callId: c.callId, name: c.name, input: {}, seq: i })), { type: "stop", reason: "tool_use", seq: calls.length }] : [{ type: "text_delta", text: "d", seq: 0 }, { type: "stop", reason: "end_turn", seq: 1 }];
		phase += 1; for (const e of events) yield e as Event;
	} } as unknown as Adapter;
}
const withDigest = (t: Tool, digest: string): Tool => ({ ...t, digest });
const run = async (registry: ToolRegistry, adapter: Adapter): Promise<Event[]> => { const out: Event[] = []; for await (const ev of loop({ adapter, model: "faux", registry, log: seedLog([USER]) } as never)) out.push(ev); return out; };
const startedOf = (events: Event[]) => events.filter((e): e is Event & { type: "tool_execution_started" } => e.type === "tool_execution_started");

describe("tool binding on the durable record", () => {
	it("a tool with a digest: its started event carries it, a child's also names its parent execution", async () => {
		const registry = new ToolRegistry(); let seen: readonly { name: string; digest?: string }[] = [];
		registry.register(defineTool({ name: "prog", description: "p", parameters: { type: "object", properties: {} }, execute: async (_i, ctx: ToolContext) => { seen = ctx.catalog!() as never; await ctx.invoke!("kid", {}); return ok("p"); } }));
		registry.register(withDigest(defineTool({ name: "kid", description: "k", parameters: { type: "object", properties: {} }, execute: async () => ok("k") }), "sha256:abc"));
		const events = await run(registry, turn([{ callId: "p1", name: "prog" }]));
		const [parent, child] = startedOf(events);
		expect((parent as { binding?: unknown }).binding).toBeUndefined(); // prog has no digest: nothing is invented
		expect((parent as { parent?: unknown }).parent).toBeUndefined();
		expect((child as { binding?: unknown }).binding).toEqual({ digest: "sha256:abc" });
		expect((child as { parent?: unknown }).parent).toBe(parent!.executionId);
		expect(seen.find((t) => t.name === "kid")!.digest).toBe("sha256:abc"); // the catalog a program reads
		expect(seen.find((t) => t.name === "prog")!.digest).toBeUndefined();
	});

	it("a direct call to a tool with a digest records the binding too, and no parent", async () => {
		const registry = new ToolRegistry();
		registry.register(withDigest(defineTool({ name: "kid", description: "k", parameters: { type: "object", properties: {} }, execute: async () => ok("k") }), "sha256:def"));
		const [s] = startedOf(await run(registry, turn([{ callId: "c1", name: "kid" }])));
		expect((s as { binding?: unknown }).binding).toEqual({ digest: "sha256:def" });
		expect((s as { parent?: unknown }).parent).toBeUndefined();
	});

	it("model-facing tool specs never carry the digest", async () => {
		const registry = new ToolRegistry();
		registry.register(withDigest(defineTool({ name: "kid", description: "k", parameters: { type: "object", properties: {} }, execute: async () => ok("k") }), "sha256:def"));
		const snap = registry.snapshot();
		expect(JSON.stringify(snap.specs)).not.toContain("sha256");
	});

	it("compatibility: an old record (no fields) is valid; a new record passes with extra keys; a malformed field is rejected", () => {
		const base = { seq: 1, type: "tool_execution_started", executionId: "ex-1", callId: "c", name: "t", input: {} };
		expect(validateEvent(base as never)).toBe(true);
		expect(validateEvent({ ...base, binding: { digest: "sha256:x" }, parent: "ex-0", someFutureField: 1 } as never)).toBe(true);
		expect(validateEvent({ ...base, binding: { digest: 5 } } as never)).toBe(false);
		expect(validateEvent({ ...base, binding: "x" } as never)).toBe(false);
		expect(validateEvent({ ...base, parent: 3 } as never)).toBe(false);
	});
});
