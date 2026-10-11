/**
 * AF-1a (owner-approved research patch) and the joint AF-5 + AF-1a tests. Nested execution has two kernel invariants:
 *   (1) a parent is not receipted while a child it started is unfinished (AF-5);
 *   (2) a child cannot bypass the isolation the kernel gives top-level calls. Only a SHARED parent can run beside other parents,
 *       so a shared parent may start only SHARED children (fail-closed: an exclusive child could not be kept alone across parents);
 *       an exclusive parent already runs alone, so its exclusive children are safe.
 * No wait-for cycle may result from the two together.
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
const SHARED = { concurrency: "shared" } as const;
const parent = (name: string, body: (ctx: ToolContext) => Promise<ToolResult>, effects?: Tool["effects"]): Tool => defineTool({ name, description: name, parameters: { type: "object", properties: {} }, ...(effects ? { effects } : {}), execute: (_i, ctx) => body(ctx) });
function worker(name: string, stats: { now: number; max: number; log: string[] }, ms = 40, effects?: Tool["effects"], ignoreAbort = false): Tool {
	return defineTool({ name, description: name, parameters: { type: "object", properties: {} }, ...(effects ? { effects } : {}), execute: async (_i, ctx) => {
		stats.now++; stats.max = Math.max(stats.max, stats.now); stats.log.push(`${name}:start`);
		await new Promise<void>((r) => { const t = setTimeout(r, ms); if (!ignoreAbort) (ctx.signal as AbortSignal | undefined)?.addEventListener?.("abort", () => { clearTimeout(t); r(); }, { once: true }); });
		stats.now--; stats.log.push(`${name}:end`); return ok(name);
	} });
}
const newStats = () => ({ now: 0, max: 0, log: [] as string[] });
async function run(registry: ToolRegistry, calls: { callId: string; name: string }[], extra: Record<string, unknown> = {}): Promise<Event[]> {
	const out: Event[] = [];
	await Promise.race([
		(async () => { for await (const ev of loop({ adapter: turn(calls), model: "faux", registry, messages: [USER], ...extra } as never)) out.push(ev); })(),
		new Promise((_, rej) => setTimeout(() => rej(new Error("DEADLOCK: the run did not end in 5 s")), 5000)),
	]);
	return out;
}
const rc = (events: Event[]) => events.filter((e) => e.type === "tool_execution_succeeded" || e.type === "tool_execution_failed").map((e) => `${(e as { callId: string }).callId}:${e.type === "tool_execution_succeeded" ? "ok" : "failed"}`);
const st = (events: Event[]) => events.filter((e) => e.type === "tool_execution_started").map((e) => (e as { callId: string }).callId);

describe("AF-1a — nested exclusivity, fail-closed", () => {
	it("a SHARED parent may not start an EXCLUSIVE child: refused before it starts, with the reason", async () => {
		const s = newStats(); const registry = new ToolRegistry(); let seen: ToolResult | undefined;
		registry.register(parent("prog", async (ctx) => { seen = await ctx.invoke!("excl", {}); return ok("p"); }, SHARED));
		registry.register(worker("excl", s));
		const events = await run(registry, [{ callId: "p1", name: "prog" }]);
		expect(seen).toMatchObject({ isError: true, errorKind: "precondition" });
		expect(String(seen!.content)).toMatch(/a shared tool may start only shared children/);
		expect(s.log).toEqual([]);
		expect(st(events)).toEqual(["p1"]);
	});
	it("a SHARED parent may start SHARED children (they overlap)", async () => {
		const s = newStats(); const registry = new ToolRegistry();
		registry.register(parent("prog", async (ctx) => { await Promise.all([ctx.invoke!("sh", {}), ctx.invoke!("sh", {}), ctx.invoke!("sh", {})]); return ok("p"); }, SHARED));
		registry.register(worker("sh", s, 30, SHARED));
		await run(registry, [{ callId: "p1", name: "prog" }]);
		expect(s.max).toBe(3);
	});
	it("an EXCLUSIVE parent may start exclusive children (alone, one after the other)", async () => {
		const s = newStats(); const registry = new ToolRegistry();
		registry.register(parent("prog", async (ctx) => { await Promise.all([ctx.invoke!("excl", {}), ctx.invoke!("excl", {})]); return ok("p"); }));
		registry.register(worker("excl", s, 20));
		await run(registry, [{ callId: "p1", name: "prog" }]);
		expect(s.max).toBe(1);
	});
	it("two SHARED parents running together, each wanting an EXCLUSIVE child: both refused, nothing overlaps (the AF-1 reproduction, now closed in the kernel)", async () => {
		const s = newStats(); const registry = new ToolRegistry(); const seen: ToolResult[] = [];
		const body = async (ctx: ToolContext) => { seen.push(await ctx.invoke!("excl", {})); return ok("p"); };
		registry.register(parent("pa", body, SHARED)); registry.register(parent("pb", body, SHARED));
		registry.register(worker("excl", s));
		await run(registry, [{ callId: "a", name: "pa" }, { callId: "b", name: "pb" }]);
		expect(seen.every((r) => r.isError)).toBe(true);
		expect(s.max).toBe(0);
	});
	it("two EXCLUSIVE parents each with an exclusive child: serial by the turn's FIFO, never together, no deadlock", async () => {
		const s = newStats(); const registry = new ToolRegistry();
		const body = async (ctx: ToolContext) => { await ctx.invoke!("excl", {}); return ok("p"); };
		registry.register(parent("pa", body)); registry.register(parent("pb", body));
		registry.register(worker("excl", s, 25));
		const events = await run(registry, [{ callId: "a", name: "pa" }, { callId: "b", name: "pb" }]);
		expect(s.max).toBe(1);
		expect(rc(events)).toEqual(["a/1:ok", "a:ok", "b/1:ok", "b:ok"]);
	});
});

describe("AF-5 + AF-1a together — no wait-for cycle", () => {
	it("an exclusive Program calling a child tool (the base case)", async () => {
		const s = newStats(); const registry = new ToolRegistry();
		registry.register(parent("prog", async (ctx) => { await ctx.invoke!("excl", {}); return ok("p"); }));
		registry.register(worker("excl", s));
		const events = await run(registry, [{ callId: "p1", name: "prog" }]);
		expect(rc(events)).toEqual(["p1/1:ok", "p1:ok"]);
	});
	it("a parent that returns early while its child runs, with an exclusive top-level call queued behind it: the child finishes, then the parent, then the queued call (no cycle)", async () => {
		const s = newStats(); const registry = new ToolRegistry();
		registry.register(parent("prog", async (ctx) => { void ctx.invoke!("sh", {}); return ok("early"); }, SHARED));
		registry.register(worker("sh", s, 60, SHARED));
		registry.register(worker("solo", s, 10));
		const events = await run(registry, [{ callId: "p1", name: "prog" }, { callId: "q1", name: "solo" }]);
		expect(rc(events)).toEqual(["p1/1:ok", "p1:ok", "q1:ok"]);
		expect(s.log).toEqual(["sh:start", "sh:end", "solo:start", "solo:end"]);
	});
	it("a parent that throws while its child ignores the abort: the parent waits for the child, then fails", async () => {
		const s = newStats(); const registry = new ToolRegistry(); const ac = new AbortController();
		registry.register(parent("prog", async (ctx) => { void ctx.invoke!("stubborn", {}); while (!s.log.includes("stubborn:start")) await new Promise((r) => setTimeout(r, 2)); ac.abort(); throw new Error("giving up"); }));
		registry.register(worker("stubborn", s, 70, undefined, true));
		const events = await run(registry, [{ callId: "p1", name: "prog" }], { signal: ac.signal });
		expect(s.log).toEqual(["stubborn:start", "stubborn:end"]);
		expect(rc(events)).toEqual(["p1/1:ok", "p1:failed"]);
	});
	it("parent and child both want the exclusive slot: the parent holds it, the child runs in the parent's lane (no self-wait)", async () => {
		const s = newStats(); const registry = new ToolRegistry();
		registry.register(parent("prog", async (ctx) => { await ctx.invoke!("excl", {}); await ctx.invoke!("excl", {}); return ok("p"); }));
		registry.register(worker("excl", s, 10));
		registry.register(parent("next", async () => ok("n")));
		const events = await run(registry, [{ callId: "p1", name: "prog" }, { callId: "n1", name: "next" }]);
		expect(rc(events)).toEqual(["p1/1:ok", "p1/2:ok", "p1:ok", "n1:ok"]);
	});
	it("four shared parents with shared children and an exclusive top-level call in the middle: all end", async () => {
		const s = newStats(); const registry = new ToolRegistry();
		const body = async (ctx: ToolContext) => { await Promise.all([ctx.invoke!("sh", {}), ctx.invoke!("sh", {})]); return ok("p"); };
		for (const n of ["pa", "pb", "pc", "pd"]) registry.register(parent(n, body, SHARED));
		registry.register(worker("sh", s, 20, SHARED)); registry.register(worker("solo", s, 10));
		const events = await run(registry, [{ callId: "a", name: "pa" }, { callId: "b", name: "pb" }, { callId: "x", name: "solo" }, { callId: "c", name: "pc" }, { callId: "d", name: "pd" }]);
		const r = rc(events);
		for (const id of ["a", "b", "x", "c", "d"]) expect(r.some((v) => v === `${id}:ok`)).toBe(true);
		// the exclusive call began only after the earlier shared parents (and their children) were receipted, and the later ones after it
		expect(r.indexOf("x:ok")).toBeGreaterThan(Math.max(r.indexOf("a:ok"), r.indexOf("b:ok")));
		expect(r.indexOf("c:ok")).toBeGreaterThan(r.indexOf("x:ok"));
		expect(r.indexOf("a:ok")).toBeGreaterThan(r.indexOf("a/2:ok"));
	});
});
