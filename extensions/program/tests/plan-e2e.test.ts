/** The plan tool through the REAL runtime: builder code -> validated plan -> engine -> child calls through the kernel. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Event, type KisoExtension } from "@vincemakes/kiso-core";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { createPlanExtension, hideTools } from "../src/index.js";

function domain(log: string[]): KisoExtension {
	const widgets: { id: number; colour: string }[] = [];
	return {
		name: "domain",
		tools: [
			defineTool({ name: "make_widget", description: "Create a widget with a colour", parameters: { type: "object", properties: { colour: { type: "string" } }, required: ["colour"] }, execute: async (i: { colour: string }) => { log.push(`make:${i.colour}`); const w = { id: widgets.length + 1, colour: i.colour }; widgets.push(w); return { content: JSON.stringify(w), isError: false }; } }),
			defineTool({ name: "list_widgets", description: "List all widgets", parameters: { type: "object", properties: {} }, execute: async () => { log.push("list"); return { content: JSON.stringify({ widgets }), isError: false }; } }),
		] as never,
	};
}

const PLAN = `
const made = map(["red", "blue", "green"], (c) => call("make_widget", { colour: c }));
const all = call("list_widgets", {}, { after: [made] });
output({ ids: pluck(made, "id"), count: len(all.widgets) });
`;

async function runPlan(code: string) {
	const log: string[] = [];
	const adapter = createFauxProvider([
		{ events: [{ type: "tool_call_end", callId: "p1", name: "plan", input: { code } }, { type: "stop", reason: "tool_use" }] },
		{ events: [{ type: "text_delta", text: "done" }, { type: "stop", reason: "end_turn" }] },
	]);
	const agent = createAgent({ model: "faux", adapter, tools: [], extensions: [createPlanExtension({ effects: (t) => (t === "list_widgets" ? { kind: "read", keys: ["w"] } : { kind: "write", keys: ["w"] }) }), hideTools(domain(log))], store: new SessionStore(mkdtempSync(join(tmpdir(), "plan-e2e-"))) });
	const session = await agent.session({ id: "s" });
	const events: Event[] = [];
	for await (const ev of session.run("go")) events.push(ev);
	return { events, log, session };
}

describe("plan tool, end to end", () => {
	it("an output that names only the steps that worked still comes back when another step failed", async () => {
		const { events } = await runPlan(`const bad = call("make_widget", {}); const ok = call("make_widget", { colour: "red" }); output({ ok });`);
		const r = (events.filter((e) => e.type === "tool_result") as unknown as { content: string }[])[0]!;
		expect(r.content).toContain('"colour":"red"');
		expect(r.content).toContain("1 failed");
	});

	it("declared calls run as ledgered child calls; the model sees one result", async () => {
		const { events, log, session } = await runPlan(PLAN);
		const started = events.filter((e) => e.type === "tool_execution_started").map((e) => `${(e as { callId: string }).callId}:${(e as { name: string }).name}`);
		expect(started).toEqual(["p1:plan", "p1/1:make_widget", "p1/2:make_widget", "p1/3:make_widget", "p1/4:list_widgets"]);
		expect(log).toEqual(["make:red", "make:blue", "make:green", "list"]);
		const results = events.filter((e) => e.type === "tool_result") as unknown as { callId: string; content: string; isError: boolean }[];
		expect(results.map((r) => r.callId)).toEqual(["p1"]);
		expect(results[0]!.isError).toBe(false);
		expect(results[0]!.content).toContain('"ids":[1,2,3]');
		expect(results[0]!.content).toContain('"count":3');
		expect(session.uncertainExecutions()).toEqual([]);
	});

	it("a plan with a mistake runs nothing and says what is wrong", async () => {
		const { events, log } = await runPlan(`const a = call("make_widget", { colour: "red" }); output(!a.id ? 1 : nope);`);
		expect(log).toEqual([]);
		const r = (events.filter((e) => e.type === "tool_result") as unknown as { content: string; isError: boolean }[])[0]!;
		expect(r.isError).toBe(true);
		expect(r.content).toMatch(/nope/);
	});

	it("a failing call is an outcome in the result, not a crash; independent calls still ran", async () => {
		const { events, log } = await runPlan(`const bad = call("make_widget", {}); const ok = call("make_widget", { colour: "red" }); output({ ok, bad });`);
		expect(log).toEqual(["make:red"]);
		const r = (events.filter((e) => e.type === "tool_result") as unknown as { content: string; isError: boolean }[])[0]!;
		expect(r.content).toContain("1 failed");
		expect(r.content).toMatch(/failed make_widget .*required property 'colour'/);
		expect(r.content).toContain("output: none"); // the output named the failed step
		expect(r.content).toContain("not undone");
	});
});
