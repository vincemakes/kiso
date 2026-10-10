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
