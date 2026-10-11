/**
 * PROGRAM P3 / seam B1, runtime side — what a child call leaves in the durable
 * log, and what a crash in the middle of a program means.
 *
 * Uses the real runtime (session, store, ledger, recovery) with a scripted
 * provider; the program tool drives its children through `ctx.invoke`.
 * Invariants exercised: I1 one identity per
 * start, I3 closed states, I4 reachable from the parent, I5 crash safety, and
 * "the verdict on a child writes no model-facing result".
 */
import { cpSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Adapter, type Tool, type ToolResult } from "@vincemakes/kiso-core";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "../src/index.js";
import { executionLedger } from "../src/ledger.js";

const ok = (content: string): ToolResult => ({ content, isError: false });

function provider(): Adapter {
	return createFauxProvider([
		{ events: [{ type: "tool_call_end", callId: "p1", name: "program", input: {} }, { type: "stop", reason: "tool_use" }] },
		{ events: [{ type: "text_delta", text: "done" }, { type: "stop", reason: "end_turn" }] },
	]);
}

function tools(applied: string[], hang: Promise<void> | null): Tool[] {
	return [
		defineTool({
			name: "program",
			description: "runs a program",
			parameters: { type: "object", properties: {} },
			execute: async (_i, ctx) => {
				await ctx.invoke!("mutate", { what: "one" });
				await ctx.invoke!("mutate", { what: "two" });
				if (hang) await ctx.invoke!("hang", {});
				return ok("program finished");
			},
		}),
		defineTool({
			name: "mutate",
			description: "a side effect",
			parameters: { type: "object", properties: { what: { type: "string" } }, required: ["what"] },
			execute: async (i: { what: string }) => { applied.push(i.what); return ok(`applied ${i.what}`); },
		}),
		defineTool({
			name: "hang",
			description: "never reports",
			parameters: { type: "object", properties: {} },
			execute: async () => { await (hang ?? Promise.resolve()); return ok("late"); },
		}),
	] as unknown as Tool[];
}

const agentOn = (dir: string, applied: string[], hang: Promise<void> | null) =>
	createAgent({ model: "faux", adapter: provider(), tools: tools(applied, hang), store: new SessionStore(dir) });

describe("P3/B1 runtime — children in the durable log", () => {
  it("a finished program leaves one succeeded execution per child, linked to the parent, and no model-facing child result", async () => {
		const dir = mkdtempSync(join(tmpdir(), "p3-ledger-"));
		const applied: string[] = [];
		const session = await agentOn(dir, applied, null).session({ id: "s" });
		const events: { type: string; callId?: string; name?: string; executionId?: string }[] = [];
		for await (const ev of session.run("go")) events.push(ev as never);
		expect(applied).toEqual(["one", "two"]);
		const ledger = [...executionLedger(session.log.all).values()];
		expect(ledger.map((r) => `${r.callId}:${r.name}:${r.status}`)).toEqual(["p1:program:succeeded", "p1/1:mutate:succeeded", "p1/2:mutate:succeeded"]);
		expect(new Set(ledger.map((r) => r.executionId)).size).toBe(3);
		expect(session.uncertainExecutions()).toEqual([]);
		expect(session.log.all.filter((e) => e.type === "tool_result").map((e) => (e as { callId: string }).callId)).toEqual(["p1"]);
	});

	it("kill -9 in the middle: the confirmed children stay confirmed, the running child and the program are uncertain, resume is blocked, and the verdict on a child adds no conversation result", async () => {
		const live = mkdtempSync(join(tmpdir(), "p3-live-"));
		const applied: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const session = await agentOn(live, applied, gate).session({ id: "s" });
		const running = (async () => { for await (const _ of session.run("go")) { /* drive */ } })();
		// wait until the third child has a durable `started` on disk, then freeze a copy: that IS the crash
		const file = () => join(live, readdirSync(live).find((f) => f.endsWith(".jsonl") && !f.includes("trace"))!);
		for (let i = 0; i < 100; i += 1) {
			await new Promise((r) => setTimeout(r, 20));
			try { if (readFileSync(file(), "utf8").includes('"p1/3"')) break; } catch { /* not yet */ }
		}
		const crashed = mkdtempSync(join(tmpdir(), "p3-crashed-"));
		cpSync(live, crashed, { recursive: true, filter: (src) => !/\.lock$|\.lock\//.test(src) }); // a dead process's lock is stale, not live
		release(); await running;

		const resumed = await agentOn(crashed, [], null).session({ id: "s" });
		const records = [...executionLedger(resumed.log.all).values()];
		const by = (callId: string) => records.find((r) => r.callId === callId)!;
		expect(by("p1/1").status).toBe("succeeded");
		expect(by("p1/2").status).toBe("succeeded");
		expect(by("p1/3").status).toBe("uncertain"); // started, no receipt
		expect(by("p1").status).toBe("uncertain"); // the program itself
		expect(resumed.uncertainExecutions().map((u) => u.callId).sort()).toEqual(["p1", "p1/3"]);
		await expect((async () => { for await (const _ of resumed.resume()) { /* */ } })()).rejects.toThrow(/blocked by 2 uncertain.*program.*mutate|blocked by 2 uncertain/s);
		// the program cannot be ruled on while one of its children is still undecided: what the model is
		// told about the program must include how every child ended
		await expect(resumed.resolveUncertain(by("p1").executionId, "abandoned")).rejects.toThrow(/child/i);
		// a human rules on the child: recorded, and NO tool_result is invented for a call the model never made
		const toolResultsBefore = resumed.log.all.filter((e) => e.type === "tool_result").length;
		await resumed.resolveUncertain(by("p1/3").executionId, "abandoned");
		expect(resumed.log.all.some((e) => e.type === "tool_execution_resolved" && (e as { callId: string }).callId === "p1/3")).toBe(true);
		expect(resumed.log.all.filter((e) => e.type === "tool_result").length).toBe(toolResultsBefore);

		// and the ruling on the PROGRAM tells the model what its children really did: two took effect,
		// the third was ruled abandoned. "must not be treated as applied" alone would be false for the first two.
		await resumed.resolveUncertain(by("p1").executionId, "abandoned");
		const told = (resumed.log.all.filter((e) => e.type === "tool_result" && (e as { callId: string }).callId === "p1").at(-1) as unknown as { content: string }).content;
		expect(told).toMatch(/mutate succeeded.*mutate succeeded/s);
		expect(told).toMatch(/hang abandoned/);
		expect(told).toMatch(/not undone|did take effect/i);
	}, 20000);

	it("a program with no children is told nothing extra", async () => {
		const dir = mkdtempSync(join(tmpdir(), "p3-nokids-"));
		const hung = createAgent({ model: "faux", adapter: createFauxProvider([{ events: [{ type: "tool_call_end", callId: "q1", name: "stuck", input: {} }, { type: "stop", reason: "tool_use" }] }]), tools: [defineTool({ name: "stuck", description: "never reports", parameters: { type: "object", properties: {} }, execute: async () => { await new Promise(() => {}); return ok("never"); } })], store: new SessionStore(dir) });
		const live = await hung.session({ id: "s" });
		void (async () => { for await (const _ of live.run("go")) { /* drive */ } })();
		const file = () => join(dir, readdirSync(dir).find((f) => f.endsWith(".jsonl") && !f.includes("trace"))!);
		for (let i = 0; i < 100; i += 1) { await new Promise((r) => setTimeout(r, 20)); try { if (readFileSync(file(), "utf8").includes("tool_execution_started")) break; } catch { /* not yet */ } }
		const crashed = mkdtempSync(join(tmpdir(), "p3-nokids2-"));
		cpSync(dir, crashed, { recursive: true, filter: (src) => !/\.lock$|\.lock\//.test(src) });
		const resumed = await createAgent({ model: "faux", adapter: createFauxProvider([]), tools: [], store: new SessionStore(crashed) }).session({ id: "s" });
		const rec = [...executionLedger(resumed.log.all).values()].find((r) => r.callId === "q1")!;
		await resumed.resolveUncertain(rec.executionId, "abandoned");
		const told = (resumed.log.all.filter((e) => e.type === "tool_result").at(-1) as unknown as { content: string }).content;
		expect(told).not.toMatch(/child/i);
	}, 20000);
});
