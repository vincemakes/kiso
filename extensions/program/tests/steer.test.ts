/**
 * Steer and new input while a program's children are running (ADR-0057 Safe Admission, kept by the nested path):
 * a steer is admitted only at a boundary where every started effect has settled - children included - so it never
 * lands in the middle of a program; the model sees the program's result first and the steer after it; no child
 * starts because of it; a second run on the same session is refused while one is open.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Adapter, type Event, type KisoExtension } from "@vincemakes/kiso-core";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { createProgramExtension, hideTools } from "../src/index.js";

const slowDomain = (log: string[]): KisoExtension => ({ name: "d", tools: [defineTool({ name: "slow", description: "s", parameters: { type: "object", properties: { n: { type: "number" } } }, execute: async (i: { n: number }) => { log.push(`start${i.n}`); await new Promise((r) => setTimeout(r, 120)); log.push(`end${i.n}`); return { content: "{}", isError: false }; } })] as never });
const spy = (inner: Adapter, requests: unknown[][]): Adapter => ({ stream: (req: { messages: unknown[] }, ...rest: unknown[]) => { requests.push(JSON.parse(JSON.stringify(req.messages))); return (inner.stream as (...a: unknown[]) => AsyncIterable<never>)(req, ...rest); } }) as unknown as Adapter;

describe("steer and new input during a program", () => {
	it("a steer sent while a child runs is admitted only after the program and every child settled; the model reads result, then steer", async () => {
		const log: string[] = [], requests: unknown[][] = [], events: Event[] = [];
		const code = `await tools.slow({ n: 1 }); await tools.slow({ n: 2 }); await tools.slow({ n: 3 }); return "done";`;
		const adapter = spy(createFauxProvider([
			{ events: [{ type: "tool_call_end", callId: "p1", name: "program", input: { code } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] },
		]), requests);
		const agent = createAgent({ model: "faux", adapter, tools: [], extensions: [createProgramExtension(), hideTools(slowDomain(log))], store: new SessionStore(mkdtempSync(join(tmpdir(), "steer-"))) });
		const session = await agent.session({ id: "s" });
		const run = session.run("go");
		let steered = false;
		for await (const ev of run) {
			events.push(ev);
			if (!steered && ev.type === "tool_execution_started" && (ev as { callId: string }).callId === "p1/2") { steered = true; run.steer("actually, change of plan"); } // while child 2 is running
		}
		expect(steered).toBe(true);
		expect(log).toEqual(["start1", "end1", "start2", "end2", "start3", "end3"]); // the program ran to the end, untouched
		expect(events.filter((e) => e.type === "tool_execution_started").map((e) => (e as { callId: string }).callId)).toEqual(["p1", "p1/1", "p1/2", "p1/3"]);
		const order = events.map((e) => e.type === "user_input" ? `user:${JSON.stringify((e as { content: unknown }).content).slice(0, 60)}` : e.type).filter((t) => ["tool_result", "tool_execution_succeeded"].includes(t) || t.startsWith("user:"));
		const steerAt = order.findIndex((t) => t.includes("change of plan")), resultAt = order.lastIndexOf("tool_result");
		expect(steerAt).toBeGreaterThan(resultAt); // the steer is after the program's result
		// the model's second request holds the program result and then the steer, in that order
		const second = JSON.stringify(requests[1]);
		expect(second.indexOf("done")).toBeGreaterThan(-1);
		expect(second.indexOf("change of plan")).toBeGreaterThan(second.indexOf("done"));
		expect(session.uncertainExecutions()).toEqual([]);
	});

	it("a second run on the same session is refused while the first is open (no input is injected into a running program)", async () => {
		const log: string[] = [];
		const adapter = createFauxProvider([
			{ events: [{ type: "tool_call_end", callId: "p1", name: "program", input: { code: `await tools.slow({ n: 1 }); return "d";` } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] },
		]);
		const agent = createAgent({ model: "faux", adapter, tools: [], extensions: [createProgramExtension(), hideTools(slowDomain(log))], store: new SessionStore(mkdtempSync(join(tmpdir(), "steer-"))) });
		const session = await agent.session({ id: "s" });
		const run = session.run("go");
		let refused = "";
		for await (const ev of run) {
			if (ev.type === "tool_execution_started" && (ev as { callId: string }).callId === "p1/1" && refused === "") {
				try { for await (const _ of session.run("a second request")) { /* */ } refused = "ACCEPTED"; } catch (e) { refused = String(e).slice(0, 100); }
			}
		}
		expect(refused).toMatch(/open run|already|busy/i);
		expect(log).toEqual(["start1", "end1"]);
	});

	it("a steer sent after the program already ended but before the run ends is admitted normally", async () => {
		const requests: unknown[][] = [];
		const adapter = spy(createFauxProvider([
			{ events: [{ type: "tool_call_end", callId: "p1", name: "program", input: { code: `return 1;` } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] },
		]), requests);
		const agent = createAgent({ model: "faux", adapter, tools: [], extensions: [createProgramExtension(), hideTools(slowDomain([]))], store: new SessionStore(mkdtempSync(join(tmpdir(), "steer-"))) });
		const session = await agent.session({ id: "s" });
		const run = session.run("go");
		let sent = false;
		for await (const ev of run) if (!sent && ev.type === "tool_result") { sent = true; run.steer("late steer"); }
		expect(JSON.stringify(requests.at(-1))).toContain("late steer");
	});
});
