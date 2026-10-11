/**
 * PROGRAM P1 / seam B1 — exposure: a tool can be callable by a program without
 * being declared to the model.
 *
 *   Tool.hidden  — left out of the specs the model sees, still dispatchable;
 *   ctx.catalog  — the tools a running tool may invoke, from the SAME per-request
 *                  table snapshot the kernel dispatches from (so what a program
 *                  discovers is what `invoke` will run; roadmap E6).
 */
import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/protocol/adapter.js";
import type { Event } from "../src/protocol/events.js";
import type { Message } from "../src/protocol/messages.js";
import { defineTool, type ToolContext, type ToolResult } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { loop } from "../src/kernel/loop.js";
import { seedLog } from "./seed.js";

const USER: Message = { role: "user", content: "go" };
const ok = (c: string): ToolResult => ({ content: c, isError: false });

function recording(offered: string[][]): Adapter {
	let phase = 0;
	return {
		stream: async function* (req: { tools?: { name: string }[] }) {
			offered.push((req.tools ?? []).map((t) => t.name));
			const events: unknown[] = phase === 0
				? [{ type: "tool_call_end", callId: "p1", name: "prog", input: {}, seq: 0 }, { type: "stop", reason: "tool_use", seq: 1 }]
				: [{ type: "text_delta", text: "done", seq: 0 }, { type: "stop", reason: "end_turn", seq: 1 }];
			phase += 1;
			for (const e of events) yield e as Event;
		},
	} as unknown as Adapter;
}

const plain = (name: string, extra: Record<string, unknown> = {}) =>
	defineTool({ name, description: `the ${name} tool`, parameters: { type: "object", properties: { v: { type: "number" } } }, ...extra, execute: async () => ok(name) } as never);

describe("hidden tools and the catalog", () => {
	it("a hidden tool is not offered to the model, but a program can list it and invoke it", async () => {
		const offered: string[][] = [];
		let catalog: { name: string; description: string }[] = [];
		let viaInvoke: ToolResult | undefined;
		const registry = new ToolRegistry();
		registry.register(defineTool({ name: "prog", description: "program", parameters: { type: "object", properties: {} }, execute: async (_i: unknown, ctx: ToolContext) => { catalog = [...ctx.catalog!()]; viaInvoke = await ctx.invoke!("secret", {}); return ok("p"); } }));
		registry.register(plain("visible"));
		registry.register(plain("secret", { hidden: true }));
		const events: Event[] = [];
		for await (const ev of loop({ adapter: recording(offered), model: "faux", registry, log: seedLog([USER]) } as never)) events.push(ev);
		expect(offered[0]).toEqual(["prog", "visible"]); // `secret` is not declared
		expect(catalog.map((t) => t.name).sort()).toEqual(["prog", "secret", "visible"]); // but it is discoverable
		expect(viaInvoke).toMatchObject({ isError: false, content: "secret" });
		expect(events.filter((e) => e.type === "tool_execution_started").map((e) => (e as { name: string }).name)).toEqual(["prog", "secret"]);
	});

	it("the catalog entries carry the input schema (what a program needs to call correctly)", async () => {
		let entry: { name: string; inputSchema?: unknown } | undefined;
		const registry = new ToolRegistry();
		registry.register(defineTool({ name: "prog", description: "program", parameters: { type: "object", properties: {} }, execute: async (_i: unknown, ctx: ToolContext) => { entry = ctx.catalog!().find((t) => t.name === "visible"); return ok("p"); } }));
		registry.register(plain("visible"));
		for await (const _ of loop({ adapter: recording([]), model: "faux", registry, log: seedLog([USER]) } as never)) void _;
		expect(entry?.inputSchema).toMatchObject({ type: "object", properties: { v: { type: "number" } } });
	});
});
