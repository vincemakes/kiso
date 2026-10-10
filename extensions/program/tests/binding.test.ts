/** Binding guard: a child whose tool contract changed after the program was admitted is refused BEFORE it starts. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Event, type KisoExtension } from "@vincemakes/kiso-core";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { createPlanExtension, createProgramExtension, hideTools } from "../src/index.js";

const domain = (effects: string[]): KisoExtension => ({
	name: "domain",
	tools: ["x", "y"].map((n) => ({ ...defineTool({ name: n, description: n, parameters: { type: "object", properties: {} }, execute: async () => { effects.push(n); return { content: "{}", isError: false }; } }), digest: `sha256:admitted-${n}` })) as never,
});
const script = (tool: string, code: string) => [
	{ events: [{ type: "tool_call_end" as const, callId: "p1", name: tool, input: { code } }, { type: "stop" as const, reason: "tool_use" as const }] },
	{ events: [{ type: "text_delta" as const, text: "done" }, { type: "stop" as const, reason: "end_turn" as const }] },
];
async function run(tool: "program" | "plan", code: string, live: Record<string, string | undefined>, asked: string[]) {
	const effects: string[] = [], events: Event[] = [];
	const binding = { liveDigest: async (n: string) => { asked.push(n); return live[n]; } };
	const front = tool === "program" ? createProgramExtension({}, { binding }) : createPlanExtension({ binding });
	const agent = createAgent({ model: "faux", adapter: createFauxProvider(script(tool, code)), tools: [], extensions: [front, hideTools(domain(effects))], store: new SessionStore(mkdtempSync(join(tmpdir(), "bind-"))) });
	const session = await agent.session({ id: "s" });
	for await (const ev of session.run("go")) events.push(ev);
	return { effects, events, text: String((events.filter((e) => e.type === "tool_result") as unknown as { content: string }[])[0]!.content), started: events.filter((e) => e.type === "tool_execution_started").map((e) => (e as { name: string }).name) };
}

describe("binding guard (program and plan)", () => {
	it("program: a child whose live contract differs is refused, nothing starts for it; an unchanged one runs; the live contract is asked once per tool", async () => {
		const asked: string[] = [];
		const r = await run("program", `const out = []; for (const t of ["x", "y", "y"]) { try { await tools[t]({}); out.push(t + " ok"); } catch (e) { out.push(t + " refused: " + String(e.message).slice(0, 90)); } } return out;`, { x: "sha256:CHANGED", y: "sha256:admitted-y" }, asked);
		expect(r.effects).toEqual(["y", "y"]);
		expect(r.started).toEqual(["program", "y", "y"]); // x never started
		expect(r.text).toMatch(/x refused: .*changed since this program was admitted/);
		expect(asked.sort()).toEqual(["x", "y"]); // once per tool, not per call
	});

	it("program: when the server cannot say (undefined) the call proceeds and the tool itself decides", async () => {
		const r = await run("program", `await tools.x({}); return "ran";`, { x: undefined }, []);
		expect(r.effects).toEqual(["x"]);
	});

	it("program: a contract that changes DURING the program is caught after the first failure; later calls to that tool are refused before they start", async () => {
		const effects: string[] = [], events: Event[] = [];
		let live = "sha256:admitted-x"; const asked: string[] = [];
		const flaky: KisoExtension = { name: "flaky", tools: [{ ...defineTool({ name: "x", description: "x", parameters: { type: "object", properties: {} }, execute: async () => { effects.push("x"); live = "sha256:CHANGED"; return { content: "server rejected the call", isError: true }; } }), digest: "sha256:admitted-x" }] as never };
		const binding = { liveDigest: async (n: string) => { asked.push(n); return live; } };
		const agent = createAgent({ model: "faux", adapter: createFauxProvider(script("program", `const o = []; for (let i = 0; i < 3; i++) { try { await tools.x({}); o.push("ok"); } catch (e) { o.push(String(e.message).slice(0, 90)); } } return o;`)), tools: [], extensions: [createProgramExtension({}, { binding }), hideTools(flaky)], store: new SessionStore(mkdtempSync(join(tmpdir(), "bind-"))) });
		const session = await agent.session({ id: "s" });
		for await (const ev of session.run("go")) events.push(ev);
		expect(effects).toEqual(["x"]); // only the first call reached the tool
		expect(events.filter((e) => e.type === "tool_execution_started").map((e) => (e as { name: string }).name)).toEqual(["program", "x"]);
		const text = String((events.filter((e) => e.type === "tool_result") as unknown as { content: string }[])[0]!.content);
		expect(text).toMatch(/changed since this program was admitted/);
		expect(asked.length).toBe(2); // before the first call, and again after it failed
	});

	it("program: recheck 'every-call' asks the live contract before each call", async () => {
		const asked: string[] = [];
		const effects: string[] = [], events: Event[] = [];
		const binding = { liveDigest: async (n: string) => { asked.push(n); return "sha256:admitted-y"; }, recheck: "every-call" as const };
		const agent = createAgent({ model: "faux", adapter: createFauxProvider(script("program", `await tools.y({}); await tools.y({}); await tools.y({}); return 1;`)), tools: [], extensions: [createProgramExtension({}, { binding }), hideTools(domain(effects))], store: new SessionStore(mkdtempSync(join(tmpdir(), "bind-"))) });
		const session = await agent.session({ id: "s" });
		for await (const ev of session.run("go")) events.push(ev);
		expect(asked).toEqual(["y", "y", "y"]);
		expect(effects).toEqual(["y", "y", "y"]);
	});

	it("plan: the same refusal; the failed step is reported with its reason, the unchanged step ran", async () => {
		const r = await run("plan", `const a = call("x", {}); const b = call("y", {}); output({ b });`, { x: "sha256:CHANGED", y: "sha256:admitted-y" }, []);
		expect(r.effects).toEqual(["y"]);
		expect(r.started).toEqual(["plan", "y"]);
		expect(r.text).toMatch(/failed x .*changed since this program was admitted/);
	});
});
