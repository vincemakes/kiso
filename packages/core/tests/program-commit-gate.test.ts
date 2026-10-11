/**
 * P0-2 (owner, round 5): the commit gate and nested calls. A `precommitSafe` parent (allowed, no human) may start before its turn commits; an effectful child
 * it starts must NOT inherit that freedom. If the turn then proves invalid, the child's effect must not have happened, and no started record exists for it.
 */
import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/protocol/adapter.js";
import type { Event } from "../src/protocol/events.js";
import type { Message } from "../src/protocol/messages.js";
import { defineTool, type Tool, type ToolResult } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { loop } from "../src/kernel/loop.js";

const USER: Message = { role: "user", content: "go" };
const ok = (c: string): ToolResult => ({ content: c, isError: false });
function delayed(phases: Event[][], gapMs: number): Adapter {
	let phase = 0;
	return { stream: async function* () { const events = phases[Math.min(phase, phases.length - 1)]!; phase += 1; for (const ev of events) { await new Promise((r) => setTimeout(r, gapMs)); yield ev; } } } as unknown as Adapter;
}
const tool = (name: string, ran: string[], effects?: Tool["effects"]): Tool => defineTool({ name, description: name, parameters: { type: "object", properties: {} }, ...(effects ? { effects } : {}), execute: async () => { ran.push(name); return ok(name); } });
const seen = { child: undefined as ToolResult | undefined };
function parentTool(effects: Tool["effects"], childName: string, wait = 0): Tool {
	return defineTool({ name: "prog", description: "p", parameters: { type: "object", properties: {} }, ...(effects ? { effects } : {}), execute: async (_i, ctx) => { if (wait) await new Promise((r) => setTimeout(r, wait)); seen.child = await ctx.invoke!(childName, {}); return ok("parent done"); } });
}
const started = (events: Event[]) => events.filter((e) => e.type === "tool_execution_started").map((e) => (e as { callId: string }).callId);

async function run(registry: ToolRegistry, turn1: Event[]): Promise<Event[]> {
	const events: Event[] = [];
	for await (const ev of loop({ adapter: delayed([turn1, [{ type: "stop", reason: "end_turn", seq: 0 }]] as unknown as Event[][], 40), model: "faux", registry, messages: [USER] })) events.push(ev);
	return events;
}
const VOIDED: Event[] = [{ type: "tool_call_end", callId: "p1", name: "prog", input: {}, seq: 0 }, { type: "stop", reason: "tool_use", seq: 1 }, { type: "text_delta", text: "one more thing", seq: 2 }] as unknown as Event[];
const COMMITTED: Event[] = [{ type: "tool_call_end", callId: "p1", name: "prog", input: {}, seq: 0 }, { type: "stop", reason: "tool_use", seq: 1 }] as unknown as Event[];

describe("a precommit-safe parent does not give its effectful children a pass through the commit gate", () => {
	it("the turn is voided after the stop: the child's effect never happens and it never starts", async () => {
		const ran: string[] = []; seen.child = undefined;
		const registry = new ToolRegistry();
		registry.register(parentTool({ precommitSafe: true }, "write_thing"));
		registry.register(tool("write_thing", ran)); // needs a committed turn
		const events = await run(registry, VOIDED);
		expect(ran).toEqual([]);
		expect(started(events)).not.toContain("p1/1");
		expect(seen.child).toMatchObject({ isError: true, errorKind: "precondition" });
		expect(String(seen.child!.content)).toMatch(/not committed|did not commit|turn/i);
		const terminal = events.filter((e) => e.type === "terminal").at(-1)!;
		expect(terminal.outcome).toMatchObject({ kind: "error" }); // the turn's verdict is unchanged
	});
	it("the turn commits: the same child runs (the gate waits, it does not refuse a good turn)", async () => {
		const ran: string[] = []; seen.child = undefined;
		const registry = new ToolRegistry();
		registry.register(parentTool({ precommitSafe: true }, "write_thing"));
		registry.register(tool("write_thing", ran));
		const events = await run(registry, COMMITTED);
		expect(ran).toEqual(["write_thing"]);
		expect(started(events)).toContain("p1/1");
	});
	it("a precommit-safe CHILD of a precommit-safe parent still runs early (the freedom is the child's own certificate)", async () => {
		const ran: string[] = []; seen.child = undefined;
		const registry = new ToolRegistry();
		registry.register(parentTool({ precommitSafe: true }, "read_thing"));
		registry.register(tool("read_thing", ran, { precommitSafe: true }));
		await run(registry, VOIDED);
		expect(ran).toEqual(["read_thing"]);
	});
	it("an exclusive parent (which waits for the commit itself) is unaffected", async () => {
		const ran: string[] = []; seen.child = undefined;
		const registry = new ToolRegistry();
		registry.register(parentTool(undefined, "write_thing"));
		registry.register(tool("write_thing", ran));
		const events = await run(registry, VOIDED);
		expect(ran).toEqual([]);
		expect(started(events)).toEqual([]); // the parent itself never started on a voided turn
	});
});
