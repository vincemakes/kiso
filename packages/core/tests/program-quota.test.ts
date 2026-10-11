/**
 * P0-3 (owner, round 5): internal approvals. A stateful, ASYNC quota policy (read the balance, think, spend it) must see approval decisions ONE AT A TIME in a
 * single order, for top-level calls and children alike; the PHYSICAL execution of what was allowed stays as concurrent as its tools declare.
 * Decision order and execution concurrency are separate things.
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
const SHARED = { concurrency: "shared" } as const;
const stats = () => ({ now: 0, max: 0, ran: [] as string[] });
const spend = (name: string, s: ReturnType<typeof stats>, ms = 30): Tool => defineTool({ name, description: name, parameters: { type: "object", properties: {} }, effects: SHARED, execute: async () => { s.now++; s.max = Math.max(s.max, s.now); s.ran.push(name); await new Promise((r) => setTimeout(r, ms)); s.now--; return ok(name); } });
const parent = (name: string, body: (ctx: ToolContext) => Promise<ToolResult>, effects?: Tool["effects"]): Tool => defineTool({ name, description: name, parameters: { type: "object", properties: {} }, ...(effects ? { effects } : {}), execute: (_i, ctx) => body(ctx) });
/** the classic read-await-write quota: only correct if decisions never overlap */
function quotaPolicy(initial: number, log: string[]) {
	let remaining = initial;
	return { decide: async (call: { name: string }) => {
		if (call.name !== "spend") return { action: "allow" as const, decidedBy: "quota" };
		const seen = remaining; log.push(`read ${seen}`);
		await new Promise((r) => setTimeout(r, 8)); // an async store lookup
		if (seen <= 0) return { action: "deny" as const, reason: "quota exhausted", decidedBy: "quota" };
		remaining = seen - 1; log.push(`spent -> ${remaining}`);
		return { action: "allow" as const, decidedBy: "quota" };
	} };
}
async function run(registry: ToolRegistry, calls: { callId: string; name: string }[], policy: unknown): Promise<Event[]> {
	const out: Event[] = [];
	for await (const ev of loop({ adapter: turn(calls), model: "faux", registry, log: seedLog([USER]), approvalPolicy: policy } as never)) out.push(ev);
	return out;
}
const startedNames = (events: Event[]) => events.filter((e) => e.type === "tool_execution_started").map((e) => `${(e as { callId: string }).callId}`);

describe("concurrent internal approvals", () => {
	it("two children of one parent asking for the LAST unit of quota: exactly one is allowed", async () => {
		const s = stats(); const log: string[] = []; const registry = new ToolRegistry(); const seen: ToolResult[] = [];
		registry.register(parent("prog", async (ctx) => { seen.push(...(await Promise.all([ctx.invoke!("spend", {}), ctx.invoke!("spend", {})]))); return ok("p"); }, SHARED));
		registry.register(spend("spend", s));
		await run(registry, [{ callId: "p1", name: "prog" }], quotaPolicy(1, log));
		expect(s.ran).toHaveLength(1);
		expect(seen.filter((r) => r.isError)).toHaveLength(1);
		expect(log).toEqual(["read 1", "spent -> 0", "read 0"]); // one decision after the other
	});
	it("children of TWO concurrent parents and a top-level call share ONE quota: five asks, quota 3, exactly three run", async () => {
		const s = stats(); const log: string[] = []; const registry = new ToolRegistry();
		const body = async (ctx: ToolContext) => { await Promise.all([ctx.invoke!("spend", {}), ctx.invoke!("spend", {})]); return ok("p"); };
		registry.register(parent("pa", body, SHARED)); registry.register(parent("pb", body, SHARED));
		registry.register(spend("spend", s));
		await run(registry, [{ callId: "a", name: "pa" }, { callId: "b", name: "pb" }, { callId: "t", name: "spend" }], quotaPolicy(3, log));
		expect(s.ran).toHaveLength(3);
		expect(log.filter((l) => l.startsWith("spent"))).toHaveLength(3);
	});
	it("decisions are made in the order the children were invoked", async () => {
		const decided: string[] = []; const registry = new ToolRegistry(); const s = stats();
		registry.register(parent("prog", async (ctx) => { await Promise.all([ctx.invoke!("spend", {}), ctx.invoke!("spend", {}), ctx.invoke!("spend", {})]); return ok("p"); }, SHARED));
		registry.register(spend("spend", s));
		const policy = { decide: async (c: { name: string }, ctx: { callId?: string }) => { if (c.name !== "spend") return { action: "allow" as const, decidedBy: "q" }; await new Promise((r) => setTimeout(r, { "p1/1": 24, "p1/2": 12, "p1/3": 1 }[String(ctx.callId)] ?? 0)); decided.push(String(ctx.callId)); return { action: "allow" as const, decidedBy: "q" }; } }; // the FIRST decision is the slowest: concurrent decisions would finish in reverse
		await run(registry, [{ callId: "p1", name: "prog" }], policy);
		expect(decided.filter((d) => d.startsWith("p1/"))).toEqual(["p1/1", "p1/2", "p1/3"]);
	});
	it("serial decisions do not serialise the EXECUTION: allowed shared children still overlap", async () => {
		const s = stats(); const registry = new ToolRegistry();
		registry.register(parent("prog", async (ctx) => { await Promise.all([ctx.invoke!("spend", {}), ctx.invoke!("spend", {}), ctx.invoke!("spend", {})]); return ok("p"); }, SHARED));
		registry.register(spend("spend", s, 60));
		await run(registry, [{ callId: "p1", name: "prog" }], quotaPolicy(5, []));
		expect(s.ran).toHaveLength(3);
		expect(s.max).toBeGreaterThan(1);
	});
	it("a child decision that throws does not poison later decisions: the parent sees the error, the next child is still decided", async () => {
		const s = stats(); const registry = new ToolRegistry(); const seen: (ToolResult | string)[] = [];
		registry.register(parent("prog", async (ctx) => { try { seen.push(await ctx.invoke!("boom", {})); } catch (e) { seen.push(String(e)); } seen.push(await ctx.invoke!("spend", {})); return ok("p"); }, SHARED));
		registry.register(spend("spend", s)); registry.register(spend("boom", s));
		const policy = { decide: async (c: { name: string }) => { if (c.name === "boom") throw new Error("policy store down"); return { action: "allow" as const, decidedBy: "q" }; } };
		await run(registry, [{ callId: "p1", name: "prog" }], policy);
		expect(s.ran).toEqual(["spend"]);
	});
});
