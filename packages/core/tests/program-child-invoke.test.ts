/**
 * PROGRAM P3 / seam B1 — a tool can invoke another tool THROUGH the kernel.
 *
 * Research branch only (roadmap `roadmap-program-research-2026-10-10`, §5).
 * The behaviour under test is `ToolContext.invoke(name, input)`: a child call
 * made by a running tool that takes the same road as a model-issued call —
 * schema validation, the composed approval chain, write-ahead `started`,
 * receipt — and that is NOT a conversation turn: the model never issued it, so
 * no `tool_result` for it may ever be written (a result without a tool_use is
 * rejected by real providers).
 *
 * Identity (invariant I1/I4): the child's callId is `<parentCallId>/<n>`; its
 * events carry NO invocationSeq (the recovery plan binds events to model calls
 * by invocationSeq, and a child must not be mistaken for one).
 *
 * B1 scope: allow / deny / validation / lane / abort. A child that the policy
 * answers `ask` is refused with an explicit result (B2 adds the human pause).
 */

import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/protocol/adapter.js";
import type { Event } from "../src/protocol/events.js";
import type { Message } from "../src/protocol/messages.js";
import { defineTool, type Tool, type ToolContext, type ToolResult } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { loop } from "../src/kernel/loop.js";
import { projectMessages } from "../src/kernel/project.js";
import { seedLog } from "./seed.js";

const USER: Message = { role: "user", content: "go" };

/** One scripted model turn that calls `names` (all in one response), then a final answer. */
function turn(calls: { callId: string; name: string; input?: Record<string, unknown> }[]): Adapter {
	let phase = 0;
	return {
		stream: async function* () {
			const events: unknown[] =
				phase === 0
					? [...calls.map((c, i) => ({ type: "tool_call_end", callId: c.callId, name: c.name, input: c.input ?? {}, seq: i })), { type: "stop", reason: "tool_use", seq: calls.length }]
					: [{ type: "text_delta", text: "done", seq: 0 }, { type: "stop", reason: "end_turn", seq: 1 }];
			phase += 1;
			for (const ev of events) yield ev as Event;
		},
	} as unknown as Adapter;
}

const ok = (content: string): ToolResult => ({ content, isError: false });

/** A parent tool whose body is `body(ctx)`. */
function parentTool(name: string, body: (ctx: ToolContext) => Promise<ToolResult>, effects?: Tool["effects"]): Tool {
	return defineTool({ name, description: name, parameters: { type: "object", properties: {} }, ...(effects !== undefined ? { effects } : {}), execute: (_i, ctx) => body(ctx) });
}

function childTool(name: string, log: string[], opts: { effects?: Tool["effects"]; ms?: number; needsNumber?: boolean } = {}): Tool {
	return defineTool({
		name,
		description: name,
		parameters: opts.needsNumber ? { type: "object", properties: { n: { type: "number" } }, required: ["n"] } : { type: "object", properties: {} },
		...(opts.effects !== undefined ? { effects: opts.effects } : {}),
		execute: async () => {
			log.push(`${name}:start`);
			if (opts.ms) await new Promise((r) => setTimeout(r, opts.ms));
			log.push(`${name}:end`);
			return ok(`${name} ok`);
		},
	});
}

async function run(registry: ToolRegistry, adapter: Adapter, extra: Record<string, unknown> = {}): Promise<Event[]> {
	const events: Event[] = [];
	for await (const ev of loop({ adapter, model: "faux", registry, log: seedLog([USER]), ...extra } as never)) events.push(ev);
	return events;
}

const started = (events: Event[]) => events.filter((e): e is Event & { type: "tool_execution_started" } => e.type === "tool_execution_started");

describe("P3/B1 — ctx.invoke: a child call takes the kernel's road", () => {
	it("is offered to a running tool", async () => {
		let offered: unknown;
		const registry = new ToolRegistry();
		registry.register(parentTool("prog", async (ctx) => { offered = ctx.invoke; return ok("p"); }));
		await run(registry, turn([{ callId: "p1", name: "prog" }]));
		expect(typeof offered).toBe("function");
	});

	it("validates a child's arguments against its own schema; the handler never sees garbage", async () => {
		const log: string[] = [];
		let seen: ToolResult | undefined;
		const registry = new ToolRegistry();
		registry.register(parentTool("prog", async (ctx) => { seen = await ctx.invoke!("kid", { n: "not a number" }); return ok("p"); }));
		registry.register(childTool("kid", log, { needsNumber: true }));
		const events = await run(registry, turn([{ callId: "p1", name: "prog" }]));
		expect(seen).toMatchObject({ isError: true, errorKind: "invalid_input" });
		expect(log).toEqual([]);
		expect(started(events).map((e) => e.name)).toEqual(["prog"]);
	});

	it("an unknown child is refused with a result, not an exception", async () => {
		let seen: ToolResult | undefined;
		const registry = new ToolRegistry();
		registry.register(parentTool("prog", async (ctx) => { seen = await ctx.invoke!("nope", {}); return ok("p"); }));
		await run(registry, turn([{ callId: "p1", name: "prog" }]));
		expect(seen).toMatchObject({ isError: true });
	});

	it("gives the child its own write-ahead `started`, then a receipt, with a callId derived from the parent's", async () => {
		const log: string[] = [];
		const registry = new ToolRegistry();
		registry.register(parentTool("prog", async (ctx) => { await ctx.invoke!("kid", {}); await ctx.invoke!("kid", {}); return ok("p"); }));
		registry.register(childTool("kid", log));
		const events = await run(registry, turn([{ callId: "p1", name: "prog" }]));
		const s = started(events);
		expect(s.map((e) => e.name)).toEqual(["prog", "kid", "kid"]);
		expect(s.map((e) => e.callId)).toEqual(["p1", "p1/1", "p1/2"]);
		expect(new Set(s.map((e) => e.executionId)).size).toBe(3); // one identity per start, identical inputs included
		for (const child of s.slice(1)) {
			expect(child.invocationSeq).toBeUndefined(); // a child is not a model call
			const receipt = events.find((e) => e.type === "tool_execution_succeeded" && e.executionId === child.executionId);
			expect(receipt).toBeDefined();
			expect(receipt!.seq).toBeGreaterThan(child.seq);
		}
		// write-ahead: the child's started is durable before its handler ran
		const firstStart = s[1]!.seq;
		expect(events.some((e) => e.seq < firstStart && e.type === "tool_execution_succeeded" && e.callId === "p1/1")).toBe(false);
		expect(log).toEqual(["kid:start", "kid:end", "kid:start", "kid:end"]);
	});

	it("never writes a tool_result for a child: the conversation holds only what the model asked for", async () => {
		const registry = new ToolRegistry();
		registry.register(parentTool("prog", async (ctx) => { await ctx.invoke!("kid", {}); return ok("p"); }));
		registry.register(childTool("kid", []));
		const events = await run(registry, turn([{ callId: "p1", name: "prog" }]));
		expect(events.filter((e) => e.type === "tool_result").map((e) => (e as { callId: string }).callId)).toEqual(["p1"]);
		const tools = projectMessages(events).filter((m) => m.role === "tool" || (m as { role: string }).role === "toolResult");
		expect(tools).toHaveLength(1);
	});

	it("a child is judged by the SAME approval chain as a direct call", async () => {
		const log: string[] = [];
		let seen: ToolResult | undefined;
		const registry = new ToolRegistry();
		registry.register(parentTool("prog", async (ctx) => { seen = await ctx.invoke!("kid", {}); return ok("p"); }));
		registry.register(childTool("kid", log));
		const asked: string[] = [];
		const events = await run(registry, turn([{ callId: "p1", name: "prog" }]), {
			approvalPolicy: {
				decide: async (call: { name: string }) => {
					asked.push(call.name);
					return call.name === "kid" ? { action: "deny" as const, reason: "no kids", decidedBy: "policy" } : { action: "allow" as const, decidedBy: "policy" };
				},
			},
		});
		expect(asked).toEqual(["prog", "kid"]);
		expect(seen).toMatchObject({ isError: true });
		expect(seen!.content).toContain("no kids");
		expect(log).toEqual([]); // the handler never ran
		expect(started(events).map((e) => e.name)).toEqual(["prog"]); // and no started record: denied calls leave none
	});

	it("B1: a child the policy answers `ask` is refused explicitly, with no human pause", async () => {
		let seen: ToolResult | undefined;
		const registry = new ToolRegistry();
		registry.register(parentTool("prog", async (ctx) => { seen = await ctx.invoke!("kid", {}); return ok("p"); }));
		registry.register(childTool("kid", []));
		let asks = 0;
		const events = await run(registry, turn([{ callId: "p1", name: "prog" }]), {
			approvalPolicy: { decide: async (call: { name: string }) => (call.name === "kid" ? { action: "ask" as const } : { action: "allow" as const, decidedBy: "policy" }) },
			resolveApproval: async () => { asks += 1; return { action: "allow" as const }; },
		});
		expect(seen).toMatchObject({ isError: true });
		expect(seen!.content).toMatch(/program|child|ask/i);
		expect(asks).toBe(0);
		expect(events.some((e) => e.type === "permission_requested" && (e as { callId: string }).callId === "p1/1")).toBe(false);
	});

	it("an abort before a child starts leaves NO started record for it", async () => {
		const log: string[] = [];
		const ac = new AbortController();
		let seen: ToolResult | undefined;
		const registry = new ToolRegistry();
		registry.register(parentTool("prog", async (ctx) => { ac.abort(); seen = await ctx.invoke!("kid", {}); return ok("p"); }));
		registry.register(childTool("kid", log));
		const events = await run(registry, turn([{ callId: "p1", name: "prog" }]), { signal: ac.signal });
		expect(log).toEqual([]);
		expect(seen).toMatchObject({ isError: true });
		expect(started(events).filter((e) => e.callId.startsWith("p1/"))).toEqual([]);
	});
});

describe("P3/B1 — lanes: no self-wait, and the barrier still serialises exclusive children", () => {
	it("an EXCLUSIVE parent with an EXCLUSIVE child completes (no self-deadlock)", async () => {
		const log: string[] = [];
		const registry = new ToolRegistry();
		registry.register(parentTool("prog", async (ctx) => ctx.invoke!("kid", {})));
		registry.register(childTool("kid", log));
		const events = await Promise.race([
			run(registry, turn([{ callId: "p1", name: "prog" }])),
			new Promise<Event[]>((_, rej) => setTimeout(() => rej(new Error("deadlock")), 2000)),
		]);
		expect(events.at(-1)!.type).toBe("terminal");
		expect(log).toEqual(["kid:start", "kid:end"]);
	});

	it("four SHARED parents, each with a SHARED child, complete (window and fence are not exhausted)", async () => {
		// B1 originally let a shared parent start an exclusive child here; AF-1a (kernel guard) now refuses that combination - see program-nesting.test.ts
		const log: string[] = [];
		const registry = new ToolRegistry();
		registry.register(parentTool("prog", async (ctx) => ctx.invoke!("kid", {}), { concurrency: "shared" }));
		registry.register(childTool("kid", log, { ms: 20, effects: { concurrency: "shared" } }));
		const calls = ["a", "b", "c", "d"].map((c) => ({ callId: c, name: "prog" }));
		const events = await Promise.race([
			run(registry, turn(calls)),
			new Promise<Event[]>((_, rej) => setTimeout(() => rej(new Error("deadlock")), 3000)),
		]);
		expect(events.at(-1)!.type).toBe("terminal");
		expect(log.filter((l) => l.endsWith(":end"))).toHaveLength(4);
	});

	it("exclusive children of one parent run one at a time; shared children overlap", async () => {
		const log: string[] = [];
		const registry = new ToolRegistry();
		registry.register(parentTool("prog", async (ctx) => {
			await Promise.all([ctx.invoke!("ex", {}), ctx.invoke!("ex", {})]);
			await Promise.all([ctx.invoke!("sh", {}), ctx.invoke!("sh", {})]);
			return ok("p");
		}));
		registry.register(childTool("ex", log, { ms: 30 }));
		registry.register(childTool("sh", log, { ms: 30, effects: { concurrency: "shared" } }));
		await run(registry, turn([{ callId: "p1", name: "prog" }]));
		expect(log.slice(0, 4)).toEqual(["ex:start", "ex:end", "ex:start", "ex:end"]);
		expect(log.slice(4, 6)).toEqual(["sh:start", "sh:start"]); // both started before either ended
	});
});

describe("P3/B1 — the crash window: a child that started and never reported is visible as such", () => {
	it("started with no receipt is in the log while the child is still running", async () => {
		const events: Event[] = [];
		const registry = new ToolRegistry();
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		registry.register(parentTool("prog", async (ctx) => ctx.invoke!("hang", {})));
		registry.register(defineTool({ name: "hang", description: "hang", parameters: { type: "object", properties: {} }, execute: async () => { await gate; return ok("late"); } }));
		const done = (async () => { for await (const ev of loop({ adapter: turn([{ callId: "p1", name: "prog" }]), model: "faux", registry, log: seedLog([USER]) } as never)) events.push(ev); })();
		await new Promise((r) => setTimeout(r, 150));
		const childStart = events.find((e) => e.type === "tool_execution_started" && (e as { callId: string }).callId === "p1/1");
		expect(childStart).toBeDefined(); // durable before the handler finished
		expect(events.some((e) => (e.type === "tool_execution_succeeded" || e.type === "tool_execution_failed") && (e as { callId: string }).callId === "p1/1")).toBe(false);
		release();
		await done;
	});
});
