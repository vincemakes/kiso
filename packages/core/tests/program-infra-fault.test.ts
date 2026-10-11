/**
 * P0-1 (owner, round 5): a child whose effect really happened and whose post-processing then throws (an infrastructure fault, here onPostTool).
 * The execution facts must stay honest: no invented failure receipt (the effect happened), no success receipt for the parent while a child is unreceipted.
 */
import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/protocol/adapter.js";
import type { Event } from "../src/protocol/events.js";
import type { Message } from "../src/protocol/messages.js";
import { defineTool, type Tool, type ToolContext, type ToolResult } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { loop } from "../src/kernel/loop.js";

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
const effectTool = (name: string, applied: string[]): Tool => defineTool({ name, description: name, parameters: { type: "object", properties: {} }, execute: async () => { applied.push(name); return ok(name); } });
async function run(registry: ToolRegistry, calls: { callId: string; name: string }[], hooks: Record<string, unknown>): Promise<{ events: Event[]; error?: unknown }> {
	const events: Event[] = []; let error: unknown;
	try { for await (const ev of loop({ adapter: turn(calls), model: "faux", registry, messages: [USER], hooks } as never)) events.push(ev); } catch (e) { error = e; }
	return { events, error };
}
const rc = (events: Event[]) => events.filter((e) => e.type === "tool_execution_succeeded" || e.type === "tool_execution_failed").map((e) => `${(e as { callId: string }).callId}:${e.type === "tool_execution_succeeded" ? "ok" : "failed"}`);
const st = (events: Event[]) => events.filter((e) => e.type === "tool_execution_started").map((e) => (e as { callId: string }).callId);
const throwOn = (name: string) => ({ onPostTool: async (c: { name: string }, r: ToolResult) => { if (c.name === name) throw new Error("post-tool hook exploded"); return r; } });

describe("an infrastructure fault after a child's effect", () => {
	it("BASELINE (direct call): the effect happened, the hook throws: what the kernel does today", async () => {
		const applied: string[] = []; const registry = new ToolRegistry();
		registry.register(effectTool("pay", applied));
		const r = await run(registry, [{ callId: "c1", name: "pay" }], throwOn("pay"));
		console.log("DIRECT:", applied.join(","), "| receipts:", rc(r.events).join(",") || "none", "| terminal:", JSON.stringify((r.events.at(-1) as { outcome?: unknown })?.outcome)?.slice(0, 80), "| threw:", r.error ? String(r.error).slice(0, 60) : "no");
		expect(applied).toEqual(["pay"]);
	});
	it("a child's post-tool hook throws after its effect: like a direct call, the child stays UNCERTAIN (no receipt), the parent gets no receipt either, and the fault propagates", async () => {
		const applied: string[] = []; const registry = new ToolRegistry();
		registry.register(parent("prog", async (ctx) => { const r = await ctx.invoke!("pay", {}); return ok(`parent saw: ${r.content.slice(0, 40)}`); }));
		registry.register(effectTool("pay", applied));
		const r = await run(registry, [{ callId: "p1", name: "prog" }], throwOn("pay"));
		expect(applied).toEqual(["pay"]); // the effect did happen
		expect(st(r.events)).toEqual(["p1", "p1/1"]);
		expect(rc(r.events)).toEqual([]); // no made-up failure for the child, no success OR failure for the parent: both are honestly unfinished
		expect(String(r.error)).toMatch(/post-tool hook exploded/); // the fault is not swallowed: the run does not end as if nothing happened
	});
	it("a parent that CATCHES the child's rejection still gets no receipt (the fault is the kernel's to carry, not the handler's)", async () => {
		const applied: string[] = []; const registry = new ToolRegistry();
		registry.register(parent("prog", async (ctx) => { try { await ctx.invoke!("pay", {}); } catch { /* swallowed */ } return ok("all fine"); }));
		registry.register(effectTool("pay", applied));
		const r = await run(registry, [{ callId: "p1", name: "prog" }], throwOn("pay"));
		expect(rc(r.events)).toEqual([]);
		expect(String(r.error)).toMatch(/post-tool hook exploded/);
	});
	it("a sibling that did not fault is still waited for and receipted before the fault surfaces", async () => {
		const applied: string[] = []; const registry = new ToolRegistry();
		registry.register(parent("prog", async (ctx) => { void ctx.invoke!("pay", {}).catch(() => undefined); void ctx.invoke!("send", {}); return ok("early"); }, { concurrency: "shared" }));
		registry.register({ ...effectTool("pay", applied), effects: { concurrency: "shared" } } as Tool);
		registry.register({ ...effectTool("send", applied), effects: { concurrency: "shared" } } as Tool);
		const r = await run(registry, [{ callId: "p1", name: "prog" }], throwOn("pay"));
		expect(applied.sort()).toEqual(["pay", "send"]);
		expect(rc(r.events)).toEqual(["p1/2:ok"]); // the healthy sibling is receipted; the faulted child and the parent are not
		expect(String(r.error)).toMatch(/post-tool hook exploded/);
	});
	it("a fault BEFORE the child started (the pre-tool hook throws: no effect possible) is only a rejection for the handler; the parent may carry on", async () => {
		const applied: string[] = []; const registry = new ToolRegistry();
		registry.register(parent("prog", async (ctx) => { try { await ctx.invoke!("pay", {}); } catch { /* nothing started */ } return ok("fine"); }));
		registry.register(effectTool("pay", applied));
		const r = await run(registry, [{ callId: "p1", name: "prog" }], { onPreTool: async (c: { name: string }) => { if (c.name === "pay") throw new Error("pre-tool hook exploded"); return { action: "allow" }; } });
		expect(applied).toEqual([]);
		expect(rc(r.events)).toEqual(["p1:ok"]);
	});
});
