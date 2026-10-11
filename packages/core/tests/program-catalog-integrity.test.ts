/**
 * Pre-merge check 1 (owner, round 7): the catalog a running tool reads through `ctx.catalog()` must not be a handle on the validation contract of THIS turn.
 * A parent that edits a catalog entry's `inputSchema` must not change what a later `ctx.invoke` is validated against, nor what the model is shown.
 * Pre-merge check 2: `hidden` means "not declared to the model" and nothing more: it is not an authorization.
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
function turn(calls: { callId: string; name: string; input?: Record<string, unknown> }[]): Adapter {
	let phase = 0;
	return { stream: async function* () {
		const evs: unknown[] = phase === 0 ? [...calls.map((c, i) => ({ type: "tool_call_end", callId: c.callId, name: c.name, input: c.input ?? {}, seq: i })), { type: "stop", reason: "tool_use", seq: calls.length }] : [{ type: "text_delta", text: "d", seq: 0 }, { type: "stop", reason: "end_turn", seq: 1 }];
		phase += 1; for (const e of evs) yield e as Event;
	} } as unknown as Adapter;
}
const parent = (name: string, body: (ctx: ToolContext) => Promise<ToolResult>): Tool => defineTool({ name, description: name, parameters: { type: "object", properties: {} }, execute: (_i, ctx) => body(ctx) });
const strictKid = (ran: string[], extra: Partial<Tool> = {}): Tool => ({ ...defineTool({ name: "kid", description: "k", parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }, execute: async () => { ran.push("kid"); return ok("kid ran"); } }), ...extra } as Tool);
async function run(registry: ToolRegistry, calls: { callId: string; name: string; input?: Record<string, unknown> }[], extra: Record<string, unknown> = {}): Promise<Event[]> {
	const out: Event[] = [];
	for await (const ev of loop({ adapter: turn(calls), model: "faux", registry, log: seedLog([USER]), ...extra } as never)) out.push(ev);
	return out;
}

describe("catalog integrity", () => {
	it("a parent that edits a catalog entry's inputSchema does not change what its next child is validated against", async () => {
		const ran: string[] = []; const registry = new ToolRegistry(); let child: ToolResult | undefined; let threw = "";
		registry.register(parent("prog", async (ctx) => {
			try {
				const schema = ctx.catalog!().find((t) => t.name === "kid")!.inputSchema as { required?: string[]; additionalProperties?: boolean; properties?: Record<string, unknown> };
				delete schema.required; schema.additionalProperties = true; schema.properties = {}; // loosen the contract
			} catch (e) { threw = String(e); } // editing may instead be refused loudly
			child = await ctx.invoke!("kid", { bogus: 1 }); // invalid against the real contract: n is required, nothing else allowed
			return ok("p");
		}));
		registry.register(strictKid(ran));
		await run(registry, [{ callId: "p1", name: "prog" }]);
		expect(ran).toEqual([]); // the handler never saw the invalid input
		expect(child).toMatchObject({ isError: true, errorKind: "invalid_input" });
		void threw;
	});
	it("the contract the model is shown is not reachable from the catalog either", async () => {
		const registry = new ToolRegistry();
		registry.register(parent("prog", async (ctx) => { try { (ctx.catalog!().find((t) => t.name === "kid")!.inputSchema as { required?: string[] }).required = []; } catch { /* refused loudly is fine */ } return ok("p"); }));
		registry.register(strictKid([]));
		const seenSchemas: unknown[] = [];
		const adapter = turn([{ callId: "p1", name: "prog" }]);
		const wrapped = { stream: (req: { tools?: { name: string; inputSchema: unknown }[] }, ...rest: unknown[]) => { seenSchemas.push(JSON.parse(JSON.stringify(req.tools ?? []))); return (adapter.stream as (...a: unknown[]) => AsyncIterable<never>)(req, ...rest); } } as unknown as Adapter;
		const out: Event[] = [];
		for await (const ev of loop({ adapter: wrapped, model: "faux", registry, log: seedLog([USER]) } as never)) out.push(ev);
		// the second request carries every tool the model may see; `kid` is a normal visible tool here and its schema is the registered one
		const second = (seenSchemas[1] as { name: string; inputSchema: { required?: string[] } }[]).find((t) => t.name === "kid")!;
		expect(second.inputSchema.required).toEqual(["n"]);
	});
	it("the registered tool itself is untouched after the run", async () => {
		const registry = new ToolRegistry(); const kid = strictKid([]);
		registry.register(parent("prog", async (ctx) => { try { delete (ctx.catalog!().find((t) => t.name === "kid")!.inputSchema as { required?: string[] }).required; } catch { /* ok */ } return ok("p"); }));
		registry.register(kid);
		await run(registry, [{ callId: "p1", name: "prog" }]);
		expect((registry.get("kid")!.parameters as { required?: string[] }).required).toEqual(["n"]);
	});
});

// ── pre-merge check 2: what `hidden` means ──────────────────────────────────────────────────────────────────
describe("hidden is visibility, not authority", () => {
	const hiddenTool = (ran: string[]): Tool => ({ ...defineTool({ name: "secret_write", description: "w", parameters: { type: "object", properties: {} }, execute: async () => { ran.push("secret_write"); return ok("written"); } }), hidden: true } as Tool);
	const results = (events: Event[]) => events.filter((e) => e.type === "tool_result").map((e) => `${(e as { callId: string }).callId}:${(e as { isError: boolean }).isError ? "error" : "ok"}:${String((e as { content: string }).content).slice(0, 40)}`);

	it("the model is never SHOWN a hidden tool (its request carries no spec for it) but the kernel's table still has it", async () => {
		const registry = new ToolRegistry(); const ran: string[] = [];
		registry.register(hiddenTool(ran)); registry.register(parent("visible", async () => ok("v")));
		const snap = registry.snapshot();
		expect(snap.specs.map((t) => t.name)).toEqual(["visible"]);
		expect(snap.catalog.map((t) => t.name).sort()).toEqual(["secret_write", "visible"]);
		expect(snap.get("secret_write")).toBeDefined();
	});
	it("a model-issued call to a hidden tool, by name, takes the ordinary road: the approval chain DECIDES it (a deny is a deny)", async () => {
		const registry = new ToolRegistry(); const ran: string[] = []; const asked: string[] = [];
		registry.register(hiddenTool(ran));
		const events = await run(registry, [{ callId: "m1", name: "secret_write" }], { approvalPolicy: { decide: async (c: { name: string }) => { asked.push(c.name); return { action: "deny" as const, reason: "no", decidedBy: "rules" }; } } });
		expect(asked).toEqual(["secret_write"]);
		expect(ran).toEqual([]);
		expect(results(events)[0]).toMatch(/^m1:error:\[Permission denied\]/);
	});
	it("hiding approves nothing: a child call to a hidden tool is decided by the same chain; denied there, it never starts", async () => {
		const registry = new ToolRegistry(); const ran: string[] = []; let child: ToolResult | undefined;
		registry.register(parent("prog", async (ctx) => { child = await ctx.invoke!("secret_write", {}); return ok("p"); }));
		registry.register(hiddenTool(ran));
		const events = await run(registry, [{ callId: "p1", name: "prog" }], { approvalPolicy: { decide: async (c: { name: string }) => (c.name === "secret_write" ? { action: "deny" as const, reason: "no", decidedBy: "rules" } : { action: "allow" as const, decidedBy: "rules" }) } });
		expect(ran).toEqual([]);
		expect(child).toMatchObject({ isError: true });
		expect(events.some((e) => e.type === "tool_execution_started" && (e as { callId: string }).callId === "p1/1")).toBe(false);
	});
	it("a hidden tool that the chain ASKS about is not auto-approved for a child (refused: no human inside a child) and is asked for when the model calls it directly", async () => {
		const registry = new ToolRegistry(); const ran: string[] = []; let child: ToolResult | undefined; const asked: string[] = [];
		registry.register(parent("prog", async (ctx) => { child = await ctx.invoke!("secret_write", {}); return ok("p"); }));
		registry.register(hiddenTool(ran));
		const policy = { decide: async (c: { name: string }) => { asked.push(c.name); return c.name === "secret_write" ? { action: "ask" as const } : { action: "allow" as const, decidedBy: "rules" }; } };
		await run(registry, [{ callId: "p1", name: "prog" }], { approvalPolicy: policy });
		expect(ran).toEqual([]);
		expect(child).toMatchObject({ isError: true }); // refused (here: no approval channel at all, or a human decision a child cannot have): never run
		const direct: Event[] = [];
		const r2 = new ToolRegistry(); r2.register(hiddenTool([]));
		const pauses: string[] = [];
		for await (const ev of loop({ adapter: turn([{ callId: "m1", name: "secret_write" }]), model: "faux", registry: r2, log: seedLog([USER]), approvalPolicy: policy, resolveApproval: async (id: string) => { pauses.push(id); return { action: "deny" as const, reason: "human said no" }; } } as never)) direct.push(ev);
		expect(pauses).toHaveLength(1); // the human was asked: hiding did not make the call free
	});
	it("PINNED CURRENT SEMANTICS: with an allowing chain, a model-issued call to a hidden tool RUNS - `hidden` is not an `internal-only` flag", async () => {
		const registry = new ToolRegistry(); const ran: string[] = [];
		registry.register(hiddenTool(ran));
		await run(registry, [{ callId: "m1", name: "secret_write" }]);
		expect(ran).toEqual(["secret_write"]);
	});
});

