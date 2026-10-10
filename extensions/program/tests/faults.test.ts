/**
 * B2 research — fault injection on nested execution through the REAL runtime (seam B1 as built; no new kernel code).
 * Each test states the invariant (kiso-doc/program-invariants.md) and what the child path does today, including the gaps.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Event, type KisoExtension } from "@vincemakes/kiso-core";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { createProgramExtension, hideTools } from "../src/index.js";

interface Rig { events: Event[]; seen: string[]; effects: string[]; session: Awaited<ReturnType<ReturnType<typeof createAgent>["session"]>> }
const sc = (code: string, direct?: { name: string; input: Record<string, unknown> }) => [
	{ events: [direct ? { type: "tool_call_end" as const, callId: "d1", name: direct.name, input: direct.input } : { type: "tool_call_end" as const, callId: "p1", name: "program", input: { code } }, { type: "stop" as const, reason: "tool_use" as const }] },
	{ events: [{ type: "text_delta" as const, text: "done" }, { type: "stop" as const, reason: "end_turn" as const }] },
];
const domain = (effects: string[], extra: Record<string, (i: never) => Promise<{ content: string; isError: boolean }>> = {}): KisoExtension => ({
	name: "domain",
	tools: [
		defineTool({ name: "secret", description: "needs approval", parameters: { type: "object", properties: { n: { type: "number" } } }, execute: async () => { effects.push("secret"); return { content: "{}", isError: false }; } }),
		defineTool({ name: "step", description: "a step", parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] }, execute: async (i: { n: number }) => { effects.push(`step${i.n}`); return { content: JSON.stringify({ n: i.n }), isError: false }; } }),
		defineTool({ name: "half", description: "applies its effect, then fails", parameters: { type: "object", properties: {} }, execute: async () => { effects.push("half-applied"); throw new Error("connection reset after write"); } }),
		...Object.entries(extra).map(([name, f]) => defineTool({ name, description: name, parameters: { type: "object", properties: {} }, execute: f as never })),
	] as never,
});
const gate = (decide: (name: string) => { action: "allow" } | { action: "deny"; reason: string } | { action: "defer" }, seen: string[]): KisoExtension => ({
	name: "gate", hooks: { onPreTool: async (call: { name: string }) => { seen.push(call.name); return decide(call.name); } } as never,
});
async function rig(script: ReturnType<typeof sc>, decide: Parameters<typeof gate>[0] = () => ({ action: "allow" }), extra?: Parameters<typeof domain>[1], signal?: AbortSignal): Promise<Rig> {
	const seen: string[] = [], effects: string[] = [], events: Event[] = [];
	const agent = createAgent({ model: "faux", adapter: createFauxProvider(script), tools: [], extensions: [createProgramExtension(), hideTools(domain(effects, extra)), gate(decide, seen)], store: new SessionStore(mkdtempSync(join(tmpdir(), "faults-"))) });
	const session = await agent.session({ id: "s" });
	for await (const ev of session.run("go", signal ? { signal } : undefined)) events.push(ev);
	return { events, seen, effects, session };
}
const startedIds = (events: Event[]) => events.filter((e) => e.type === "tool_execution_started").map((e) => (e as { callId: string }).callId);
const receipts = (events: Event[]) => events.filter((e) => e.type === "tool_execution_succeeded" || e.type === "tool_execution_failed").map((e) => `${(e as { callId: string }).callId}:${e.type.replace("tool_execution_", "")}`);

describe("B2 research — nested execution under faults", () => {
	it("I7/I8: a denied child is an error value; retrying 5 times asks the chain 5 times and never gets through; nothing starts", async () => {
		const code = `let last; for (let i = 0; i < 5; i++) { try { await tools.secret({ n: i }); return "got through"; } catch (e) { last = String(e.message); } } return "denied x5: " + last;`;
		const r = await rig(sc(code), (n) => (n === "secret" ? { action: "deny", reason: "not allowed here" } : { action: "allow" }));
		expect(r.seen.filter((n) => n === "secret")).toHaveLength(5); // every retry is a NEW call through the chain
		expect(r.effects).toEqual([]);
		expect(startedIds(r.events)).toEqual(["p1"]); // no started record for any denied child
		const res = (r.events.filter((e) => e.type === "tool_result") as unknown as { content: string }[])[0]!.content;
		expect(res).toContain("denied x5");
		expect(res).toMatch(/not allowed here/);
	});

	it("I7 GAP (B2): a child the policy answers `ask` is REFUSED, while the same call made directly by the model PAUSES for a human", async () => {
		const ask = (n: string) => (n === "secret" ? ({ action: "defer" } as const) : ({ action: "allow" } as const));
		const viaProgram = await rig(sc(`try { await tools.secret({}); return "ran"; } catch (e) { return "refused: " + e.message; }`), ask);
		const res = (viaProgram.events.filter((e) => e.type === "tool_result") as unknown as { content: string }[])[0]!.content;
		expect(res).toContain("refused");
		expect(viaProgram.events.some((e) => e.type === ("permission_requested" as never))).toBe(false);
		expect(viaProgram.effects).toEqual([]);
		// the model calls the same tool itself (the faux model calls `secret` directly; not hidden here)
		const seen: string[] = [], effects: string[] = [], events: Event[] = [];
		const agent = createAgent({ model: "faux", adapter: createFauxProvider(sc("", { name: "secret", input: {} })), tools: [], extensions: [domain(effects), gate(ask, seen)], store: new SessionStore(mkdtempSync(join(tmpdir(), "faults-"))) });
		const session = await agent.session({ id: "s" });
		const stop = new AbortController();
		for await (const ev of session.run("go", { signal: stop.signal })) { events.push(ev); if (ev.type === ("permission_requested" as never)) stop.abort(); } // the run waits for a human: stop watching
		expect(events.some((e) => e.type === ("permission_requested" as never))).toBe(true); // a human decision is asked for
		expect(effects).toEqual([]); // and nothing ran before it
	});

	it("I12: an abort during a child stops later children before they start; every started record has a receipt", async () => {
		const ac = new AbortController();
		const code = `await tools.step({ n: 1 }); await tools.slow({}); await tools.step({ n: 3 }); await tools.step({ n: 4 }); return "finished";`;
		const r = await rig(sc(code), () => ({ action: "allow" }), { slow: async () => { ac.abort(); return { content: "{}", isError: false }; } }, ac.signal);
		expect(r.effects).toEqual(["step1"]); // step3 / step4 never ran
		const ids = startedIds(r.events);
		expect(ids).toContain("p1/1"); expect(ids).toContain("p1/2");
		expect(ids).not.toContain("p1/3"); expect(ids).not.toContain("p1/4");
		const rc = receipts(r.events);
		for (const id of ids) expect(rc.some((x) => x.startsWith(`${id}:`)), `receipt for ${id}`).toBe(true);
		expect(r.session.uncertainExecutions()).toEqual([]);
	});

	it("I3/partial success: a child that applied its effect and then failed is a receipted failure; the script may go on; the model is told", async () => {
		const code = `const out = []; out.push((await tools.step({ n: 1 })).n); try { await tools.half({}); } catch (e) { out.push("half failed: " + e.message); } out.push((await tools.step({ n: 2 })).n); return out;`;
		const r = await rig(sc(code));
		expect(r.effects).toEqual(["step1", "half-applied", "step2"]);
		expect(receipts(r.events)).toEqual(expect.arrayContaining(["p1/1:succeeded", "p1/2:failed", "p1/3:succeeded", "p1:succeeded"]));
		const res = (r.events.filter((e) => e.type === "tool_result") as unknown as { content: string }[])[0]!.content;
		expect(res).toMatch(/half failed/);
		expect(res).toMatch(/1 of 3 tool calls failed \(half\).*partially applied/s);
	});

	it("honesty: a failed child whose error the script swallows is still named in the result", async () => {
		const r = await rig(sc(`try { await tools.half({}); } catch (e) { /* ignored */ } return "all good";`));
		expect(r.effects).toEqual(["half-applied"]);
		const res = (r.events.filter((e) => e.type === "tool_result") as unknown as { content: string }[])[0]!.content;
		expect(res).toContain("all good");
		expect(res).toMatch(/1 of 1 tool calls? failed \(half\).*partially applied/s);
	});

	it("I2/I5: the program is receipted only after EVERY child it started has a receipt (call budget, abort and time-out paths)", async () => {
		const ac = new AbortController();
		const slow = async () => { await new Promise((r) => setTimeout(r, 60)); return { content: "{}", isError: false }; };
		const code = `const p = [tools.slow({}), tools.slow({})]; await Promise.all(p);`;
		const r = await rig(sc(code), () => ({ action: "allow" }), { slow }, ac.signal);
		void r;
		const ac2 = new AbortController();
		const events: Event[] = [];
		const effects: string[] = [];
		const agent = createAgent({ model: "faux", adapter: createFauxProvider(sc(`tools.slow({}); tools.slow({}); await new Promise(() => {}); `)), tools: [], extensions: [createProgramExtension({ timeoutMs: 30 }), hideTools(domain(effects, { slow })), gate(() => ({ action: "allow" }), [])], store: new SessionStore(mkdtempSync(join(tmpdir(), "faults-"))) });
		const session = await agent.session({ id: "s" });
		for await (const ev of session.run("go", { signal: ac2.signal })) events.push(ev);
		const order = events.filter((e) => e.type === "tool_execution_succeeded" || e.type === "tool_execution_failed").map((e) => (e as { callId: string }).callId);
		expect(order.at(-1)).toBe("p1"); // the parent's receipt comes last
		for (const id of startedIds(events)) expect(order, id).toContain(id);
		expect(session.uncertainExecutions()).toEqual([]);
	});

	it("I13: a runaway fan-out is bounded and the calls that did start are all receipted", async () => {
		const code = `const all = []; for (let i = 0; i < 100000; i++) all.push(tools.step({ n: i })); return (await Promise.all(all)).length;`;
		const r = await rig(sc(code));
		const ids = startedIds(r.events).filter((x) => x.startsWith("p1/"));
		expect(ids.length).toBeLessThanOrEqual(500); // the program's call budget
		const rc = receipts(r.events);
		const missing = ids.filter((id) => !rc.some((x) => x.startsWith(`${id}:`)));
		process.stderr.write("FANOUT>> started="+ids.length+" missing receipts="+missing.length+" first="+missing.slice(0,3)+" uncertain="+r.session.uncertainExecutions().length+" parent receipt="+rc.filter((x)=>x.startsWith("p1:"))+"<<\n");
		for (const id of ids) expect(rc.some((x) => x.startsWith(`${id}:`))).toBe(true);
		const res = (r.events.filter((e) => e.type === "tool_result") as unknown as { content: string; isError: boolean }[])[0]!;
		expect(res.isError).toBe(true);
	});
});
