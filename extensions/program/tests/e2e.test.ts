/**
 * The program tool through the REAL runtime: a scripted model calls `program`;
 * the script finds and calls tools the model was never shown; every child call is
 * a ledgered execution; the conversation holds only the program's own result.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Adapter, type Event, type KisoExtension } from "@vincemakes/kiso-core";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { createProgramExtension, hideTools } from "../src/index.js";

const SCRIPT = `
const hits = await searchTools("widget");
const made = await Promise.all([tools.make_widget({ colour: "red" }), tools.make_widget({ colour: "blue" })]);
const all = await tools.list_widgets({});
return { found: hits.map(h => h.name), made: made.map(m => m.id), count: all.widgets.length };
`;

function domain(): KisoExtension {
	const widgets: { id: number; colour: string }[] = [];
	return {
		name: "domain",
		tools: [
			defineTool({ name: "make_widget", description: "Create a widget with a colour", parameters: { type: "object", properties: { colour: { type: "string" } }, required: ["colour"] }, execute: async (i: { colour: string }) => { const w = { id: widgets.length + 1, colour: i.colour }; widgets.push(w); return { content: JSON.stringify(w), isError: false }; } }),
			defineTool({ name: "list_widgets", description: "List all widgets", parameters: { type: "object", properties: {} }, execute: async () => ({ content: JSON.stringify({ widgets }), isError: false }) }),
		] as never,
	};
}

function spy(inner: Adapter, offered: string[][]): Adapter {
	return { stream: (req: { tools?: { name: string }[] }, ...rest: unknown[]) => { offered.push((req.tools ?? []).map((t) => t.name)); return (inner.stream as (...a: unknown[]) => AsyncIterable<never>)(req, ...rest); } } as unknown as Adapter;
}

describe("program tool, end to end", () => {
	it("a script uses tools the model was not shown; each child call is ledgered; the model sees one result", async () => {
		const offered: string[][] = [];
		const adapter = spy(createFauxProvider([
			{ events: [{ type: "tool_call_end", callId: "p1", name: "program", input: { code: SCRIPT } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "done" }, { type: "stop", reason: "end_turn" }] },
		]), offered);
		const agent = createAgent({ model: "faux", adapter, tools: [], extensions: [createProgramExtension(), hideTools(domain())], store: new SessionStore(mkdtempSync(join(tmpdir(), "prog-e2e-"))) });
		const session = await agent.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.run("make two widgets")) events.push(ev);

		expect(offered[0]).toEqual(["program"]); // the domain tools are hidden
		const started = events.filter((e) => e.type === "tool_execution_started").map((e) => `${(e as { callId: string }).callId}:${(e as { name: string }).name}`);
		expect(started).toEqual(["p1:program", "p1/1:make_widget", "p1/2:make_widget", "p1/3:list_widgets"]);
		const results = events.filter((e) => e.type === "tool_result") as unknown as { callId: string; content: string; isError: boolean }[];
		expect(results.map((r) => r.callId)).toEqual(["p1"]);
		expect(results[0]!.isError).toBe(false);
		expect(results[0]!.content).toContain("Script completed (3 tool calls");
		expect(results[0]!.content).toContain('"count": 2');
		expect(results[0]!.content).toContain("make_widget");
		expect(session.uncertainExecutions()).toEqual([]);
	});

	it("a script that fails after some calls reports them honestly, and the program's receipt is a failure", async () => {
		const bad = `await tools.make_widget({ colour: "red" }); await tools.make_widget({}); return 1;`; // the second call has no colour
		const adapter = createFauxProvider([
			{ events: [{ type: "tool_call_end", callId: "p1", name: "program", input: { code: bad } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] },
		]);
		const agent = createAgent({ model: "faux", adapter, tools: [], extensions: [createProgramExtension(), hideTools(domain())], store: new SessionStore(mkdtempSync(join(tmpdir(), "prog-e2e-"))) });
		const session = await agent.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.run("go")) events.push(ev);
		const result = (events.filter((e) => e.type === "tool_result") as unknown as { content: string; isError: boolean }[])[0]!;
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Script failed");
		expect(result.content).toMatch(/make_widget ok, make_widget error/);
		expect(result.content).toMatch(/side effects may have partially applied/);
		// the invalid child never started: validation refused it, like a direct call
		expect(events.filter((e) => e.type === "tool_execution_started").map((e) => (e as { callId: string }).callId)).toEqual(["p1", "p1/1"]);
	});
});
