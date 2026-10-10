/** Once a host declares a tool `shared`, nothing bounds how many children overlap (the kernel window is for model calls): the program extension bounds them. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Event, type KisoExtension } from "@vincemakes/kiso-core";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { createPlanExtension, createProgramExtension, hideTools } from "../src/index.js";

function probe(stats: { now: number; max: number }): KisoExtension {
	return { name: "probe", tools: [defineTool({ name: "read", description: "r", parameters: { type: "object", properties: { n: { type: "number" } } }, effects: { concurrency: "shared" }, execute: async () => { stats.now++; stats.max = Math.max(stats.max, stats.now); await new Promise((r) => setTimeout(r, 15)); stats.now--; return { content: "{}", isError: false }; } })] as never };
}
async function run(tool: "program" | "plan", code: string, front: KisoExtension) {
	const stats = { now: 0, max: 0 }; const events: Event[] = [];
	const adapter = createFauxProvider([
		{ events: [{ type: "tool_call_end", callId: "p1", name: tool, input: { code } }, { type: "stop", reason: "tool_use" }] },
		{ events: [{ type: "text_delta", text: "d" }, { type: "stop", reason: "end_turn" }] },
	]);
	const agent = createAgent({ model: "faux", adapter, tools: [], extensions: [front, hideTools(probe(stats))], store: new SessionStore(mkdtempSync(join(tmpdir(), "lim-"))) });
	const session = await agent.session({ id: "s" });
	for await (const ev of session.run("go")) events.push(ev);
	return { stats, events };
}
describe("child concurrency bound", () => {
	it("program: 40 shared children, bound 5 -> never more than 5 at once, all 40 run", async () => {
		const r = await run("program", `await Promise.all(Array.from({ length: 40 }, (_, i) => tools.read({ n: i }))); return 1;`, createProgramExtension({}, { maxConcurrentChildren: 5 }));
		expect(r.stats.max).toBe(5);
		expect(r.events.filter((e) => e.type === "tool_execution_succeeded" && String((e as { callId: string }).callId).startsWith("p1/")).length).toBe(40);
	});
	it("the default bound is 8", async () => {
		const r = await run("program", `await Promise.all(Array.from({ length: 30 }, (_, i) => tools.read({ n: i }))); return 1;`, createProgramExtension());
		expect(r.stats.max).toBe(8);
	});
	it("plan: engine concurrency and the bound both apply (the smaller wins)", async () => {
		const r = await run("plan", `const xs = map(${JSON.stringify(Array.from({ length: 30 }, (_, i) => i))}, (i) => call("read", { n: i })); output(len(xs));`, createPlanExtension({ effects: () => ({ kind: "read", keys: "*" }), maxConcurrentChildren: 3 }));
		expect(r.stats.max).toBe(3);
	});
});

// ── agent-wide, not per script (owner's ruling 2026-10-11) ───────────────────────────────────────
import { withEffects, ChildLimiter } from "../src/index.js";
async function twoPrograms(front: KisoExtension[], codeA: string, codeB: string, declareShared: boolean) {
	const stats = { now: 0, max: 0 };
	const adapter = createFauxProvider([
		{ events: [{ type: "tool_call_end", callId: "pa", name: "program", input: { code: codeA } }, { type: "tool_call_end", callId: "pb", name: "program", input: { code: codeB } }, { type: "stop", reason: "tool_use" }] },
		{ events: [{ type: "text_delta", text: "d" }, { type: "stop", reason: "end_turn" }] },
	]);
	const fronts = declareShared ? front.map((f) => withEffects(f, (t) => (t.name === "program" ? { concurrency: "shared" } : undefined), { allowSharedProgram: true })) : front;
	const agent = createAgent({ model: "faux", adapter, tools: [], extensions: [...fronts, hideTools(probe(stats))], store: new SessionStore(mkdtempSync(join(tmpdir(), "lim-"))) });
	const session = await agent.session({ id: "s" });
	const events: Event[] = [];
	for await (const ev of session.run("go")) events.push(ev);
	return { stats, events };
}
const BURST = (tag: string) => `await Promise.all(Array.from({ length: 20 }, (_, i) => tools.read({ n: i }))); return "${tag}";`;
describe("one bound for the whole agent", () => {
	it("two programs the kernel runs one after the other never exceed the bound (default: the program tool is exclusive)", async () => {
		const r = await twoPrograms([createProgramExtension({}, { maxConcurrentChildren: 6 })], BURST("a"), BURST("b"), false);
		expect(r.stats.max).toBe(6);
	});
	it("two programs the HOST made concurrent still share ONE bound (not 2 x bound)", async () => {
		const r = await twoPrograms([createProgramExtension({}, { maxConcurrentChildren: 6 })], BURST("a"), BURST("b"), true);
		expect(r.stats.max).toBeLessThanOrEqual(6);
		expect(r.stats.max).toBeGreaterThan(1);
	});
	it("a limiter the host passes to both extensions bounds program and plan children together", async () => {
		const limiter = new ChildLimiter({ global: 4 });
		const r = await twoPrograms([createProgramExtension({}, { limiter })], BURST("a"), BURST("b"), true);
		expect(r.stats.max).toBeLessThanOrEqual(4);
	});
	it("a per-server group bound is respected inside the global one", async () => {
		const limiter = new ChildLimiter({ global: 8, perGroup: 2, groupOf: () => "svc" });
		const r = await twoPrograms([createProgramExtension({}, { limiter })], BURST("a"), BURST("b"), true);
		expect(r.stats.max).toBeLessThanOrEqual(2);
	});
});

// ── AUDIT: exclusivity of an EXCLUSIVE child across two concurrent programs ───────────────────────
describe("audit: an exclusive child is alone across programs", () => {
	it.fails("KERNEL GAP (audit AF-1, documented as an expected failure): two programs the HOST made concurrent, each calling an EXCLUSIVE tool: the kernel's 'while it runs, it runs alone' must hold between them", async () => {
		const stats = { now: 0, max: 0 };
		const excl: KisoExtension = { name: "excl", tools: [defineTool({ name: "write", description: "w", parameters: { type: "object", properties: { n: { type: "number" } } }, execute: async () => { stats.now++; stats.max = Math.max(stats.max, stats.now); await new Promise((r) => setTimeout(r, 40)); stats.now--; return { content: "{}", isError: false }; } })] as never }; // no effects: exclusive
		const code = (t: string) => `await tools.write({ n: 1 }); await tools.write({ n: 2 }); return "${t}";`;
		const adapter = createFauxProvider([
			{ events: [{ type: "tool_call_end", callId: "pa", name: "program", input: { code: code("a") } }, { type: "tool_call_end", callId: "pb", name: "program", input: { code: code("b") } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "d" }, { type: "stop", reason: "end_turn" }] },
		]);
		const front = withEffects(createProgramExtension(), (t) => (t.name === "program" ? { concurrency: "shared" } : undefined), { allowSharedProgram: true });
		const agent = createAgent({ model: "faux", adapter, tools: [], extensions: [front, hideTools(excl)], store: new SessionStore(mkdtempSync(join(tmpdir(), "lim-"))) });
		const session = await agent.session({ id: "s" });
		for await (const _ of session.run("go")) { /* */ }
		expect(stats.max).toBe(1);
	});
});

describe("the extension refuses the unsafe declaration by default", () => {
	it("declaring the program or plan tool shared throws unless the research flag is passed", () => {
		expect(() => (withEffects(createProgramExtension(), () => ({ concurrency: "shared" })).tools ?? []).length).toThrow(/must not be declared shared/);
		expect(() => (withEffects(createPlanExtension(), () => ({ concurrency: "shared" })).tools ?? []).length).toThrow(/must not be declared shared/);
		expect((withEffects(createProgramExtension(), () => ({ concurrency: "shared" }), { allowSharedProgram: true }).tools ?? []).length).toBe(1);
	});
});
