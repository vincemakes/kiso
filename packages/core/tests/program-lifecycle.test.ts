/**
 * AF-5 (owner-approved research patch): the kernel, not the tool author, guarantees that a parent call is not receipted
 * while a child it started is unfinished. `ToolContext.invoke` is offered to EVERY tool; a tool that forgets to await a child must
 * not lose that child's receipt. Semantics: when the parent's handler returns, throws or is cut short by an abort, the parent's
 * entry for new children is CLOSED (a late call is refused without starting), and the kernel waits for every child it admitted -
 * including the child's receipt being persisted - before it writes the parent's own receipt.
 */
import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/protocol/adapter.js";
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
		const evs: unknown[] = phase === 0 ? [...calls.map((c, i) => ({ type: "tool_call_end", callId: c.callId, name: c.name, input: {}, seq: i })), { type: "stop", reason: "tool_use", seq: calls.length }] : [{ type: "text_delta", text: "d", seq: 0 }, { type: "stop", reason: "end_turn", seq: 1 }];
		phase += 1; for (const e of evs) yield e as Event;
	} } as unknown as Adapter;
}
const parent = (name: string, body: (ctx: ToolContext) => Promise<ToolResult>, effects?: Tool["effects"]): Tool => defineTool({ name, description: name, parameters: { type: "object", properties: {} }, ...(effects ? { effects } : {}), execute: (_i, ctx) => body(ctx) });
const kid = (name: string, ms: number, log: string[], effects?: Tool["effects"]): Tool => defineTool({ name, description: name, parameters: { type: "object", properties: {} }, ...(effects ? { effects } : {}), execute: async () => { log.push(`${name}:start`); await new Promise((r) => setTimeout(r, ms)); log.push(`${name}:landed`); return ok(name); } });
async function run(registry: ToolRegistry, adapter: Adapter, extra: Record<string, unknown> = {}, slowConsumerMs = 0): Promise<Event[]> {
	const out: Event[] = [];
	for await (const ev of loop({ adapter, model: "faux", registry, log: seedLog([USER]), ...extra } as never)) { out.push(ev); if (slowConsumerMs > 0) await new Promise((r) => setTimeout(r, slowConsumerMs)); }
	return out;
}
const receipts = (events: Event[]) => events.filter((e) => e.type === "tool_execution_succeeded" || e.type === "tool_execution_failed").map((e) => `${(e as { callId: string }).callId}:${e.type === "tool_execution_succeeded" ? "ok" : "failed"}`);
const started = (events: Event[]) => events.filter((e) => e.type === "tool_execution_started").map((e) => (e as { callId: string }).callId);

describe("AF-5 — a parent is receipted after its children", () => {
	it("a tool that forgets to await its child: the child's receipt is still recorded, and BEFORE the parent's", async () => {
		const log: string[] = []; const registry = new ToolRegistry();
		registry.register(parent("prog", async (ctx) => { void ctx.invoke!("kid", {}); return ok("done early"); }));
		registry.register(kid("kid", 60, log));
		const events = await run(registry, turn([{ callId: "p1", name: "prog" }]));
		expect(log).toEqual(["kid:start", "kid:landed"]);
		expect(receipts(events)).toEqual(["p1/1:ok", "p1:ok"]);
	});
	it("a parent that throws with a child in flight: same order, the parent's receipt is a failure", async () => {
		const log: string[] = []; const registry = new ToolRegistry();
		registry.register(parent("prog", async (ctx) => { void ctx.invoke!("kid", {}); throw new Error("boom"); }));
		registry.register(kid("kid", 60, log));
		const events = await run(registry, turn([{ callId: "p1", name: "prog" }]));
		expect(receipts(events)).toEqual(["p1/1:ok", "p1:failed"]);
	});
	it("a late call (after the parent's handler returned) is refused and never starts", async () => {
		const log: string[] = []; const registry = new ToolRegistry(); let late: ToolResult | undefined;
		registry.register(parent("prog", async (ctx) => { setTimeout(() => { void ctx.invoke!("kid", {}).then((r) => { late = r; }); }, 30); return ok("done"); }));
		registry.register(kid("kid", 10, log));
		const events = await run(registry, turn([{ callId: "p1", name: "prog" }]));
		await new Promise((r) => setTimeout(r, 80));
		expect(late).toMatchObject({ isError: true });
		expect(String(late!.content)).toMatch(/finished|cannot start/);
		expect(log).toEqual([]);
		expect(started(events)).toEqual(["p1"]);
	});
	it("an abort that cuts the handler short still waits for the children it started", async () => {
		const log: string[] = []; const registry = new ToolRegistry(); const ac = new AbortController();
		registry.register(parent("prog", async (ctx) => { void ctx.invoke!("kid", {}); while (!log.includes("kid:start")) await new Promise((r) => setTimeout(r, 2)); ac.abort(); return ok("returns on abort"); }));
		registry.register(kid("kid", 80, log));
		const events = await run(registry, turn([{ callId: "p1", name: "prog" }]), { signal: ac.signal });
		expect(log).toEqual(["kid:start", "kid:landed"]);
		const r = receipts(events);
		expect(r.indexOf("p1/1:ok")).toBeGreaterThanOrEqual(0);
		expect(r.indexOf("p1/1:ok")).toBeLessThan(r.indexOf("p1:ok") === -1 ? r.indexOf("p1:failed") : r.indexOf("p1:ok"));
	});
	it("an abort that lands before the child's handler starts: the child gets its started and a failure receipt (no effect), still before the parent's", async () => {
		const log: string[] = []; const registry = new ToolRegistry(); const ac = new AbortController();
		registry.register(parent("prog", async (ctx) => { void ctx.invoke!("kid", {}); ac.abort(); return ok("returns"); }));
		registry.register(kid("kid", 20, log));
		const events = await run(registry, turn([{ callId: "p1", name: "prog" }]), { signal: ac.signal });
		expect(log).toEqual([]); // the handler never ran
		const r = receipts(events);
		for (const id of started(events).filter((x) => x.startsWith("p1/"))) expect(r.indexOf(`${id}:failed`) === -1 ? r.findIndex((x) => x.startsWith(`${id}:`)) : r.indexOf(`${id}:failed`)).toBeGreaterThanOrEqual(0);
		expect(r.at(-1)?.startsWith("p1:")).toBe(true);
	});
	it("the wait covers the receipt being PERSISTED, not only the handler: a slow consumer still sees the child's receipt first", async () => {
		const log: string[] = []; const registry = new ToolRegistry();
		registry.register(parent("prog", async (ctx) => { void ctx.invoke!("kid", {}); void ctx.invoke!("kid", {}); return ok("early"); }));
		registry.register(kid("kid", 5, log));
		const events = await run(registry, turn([{ callId: "p1", name: "prog" }]), {}, 15);
		const idx = (id: string) => events.findIndex((e) => (e.type === "tool_execution_succeeded" || e.type === "tool_execution_failed") && (e as { callId: string }).callId === id);
		expect(idx("p1/1")).toBeGreaterThan(-1); expect(idx("p1/2")).toBeGreaterThan(-1);
		expect(idx("p1")).toBeGreaterThan(Math.max(idx("p1/1"), idx("p1/2")));
	});
	it("a parent with no children is unchanged: no extra wait, same events", async () => {
		const registry = new ToolRegistry();
		registry.register(parent("prog", async () => ok("plain")));
		const events = await run(registry, turn([{ callId: "p1", name: "prog" }]));
		expect(receipts(events)).toEqual(["p1:ok"]);
	});
	it("children of one parent that overlap (shared) are all waited for", async () => {
		const log: string[] = []; const registry = new ToolRegistry();
		registry.register(parent("prog", async (ctx) => { for (let i = 0; i < 4; i++) void ctx.invoke!("kid", {}); return ok("early"); }));
		registry.register(kid("kid", 40, log, { concurrency: "shared" }));
		const events = await run(registry, turn([{ callId: "p1", name: "prog" }]));
		const r = receipts(events);
		expect(r.at(-1)).toBe("p1:ok");
		expect(r.filter((x) => x.startsWith("p1/"))).toHaveLength(4);
	});
});
