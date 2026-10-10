/**
 * B2-F10 — a child that ignores the abort outlives the program's grace period.
 * Question: when the program has reported its end while the child is still running remotely, is the child
 * still tracked (uncertain / receipted when it ends), and what does a crash at each moment leave?
 */
import { cpSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Event, type KisoExtension } from "@vincemakes/kiso-core";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { createProgramExtension, hideTools } from "../src/index.js";

const SCRIPT = `await tools.step({ n: 1 }); tools.stubborn({}); await new Promise(() => {}); return "never";`;
const script = [
	{ events: [{ type: "tool_call_end" as const, callId: "p1", name: "program", input: { code: SCRIPT } }, { type: "stop" as const, reason: "tool_use" as const }] },
	{ events: [{ type: "text_delta" as const, text: "done" }, { type: "stop" as const, reason: "end_turn" as const }] },
];
const setup = (gate: Promise<void>, applied: string[]): KisoExtension => ({
	name: "domain",
	tools: [
		defineTool({ name: "step", description: "s", parameters: { type: "object", properties: { n: { type: "number" } } }, execute: async () => ({ content: "{}", isError: false }) }),
		// ignores ctx.signal on purpose: a remote write that cannot be cancelled once sent
		defineTool({ name: "stubborn", description: "remote write that ignores the abort", parameters: { type: "object", properties: {} }, execute: async () => { await gate; applied.push("stubborn-landed"); return { content: "{}", isError: false }; } }),
	] as never,
});
const records = (dir: string) => {
	const f = readdirSync(dir).find((x) => x.endsWith(".jsonl") && !x.includes("trace"))!;
	const evs = readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => { const o = JSON.parse(l); return (o.event ?? o) as { type: string; callId?: string; executionId?: string; name?: string }; });
	const started = evs.filter((e) => e.type === "tool_execution_started");
	const rec = new Map(evs.filter((e) => e.type === "tool_execution_succeeded" || e.type === "tool_execution_failed").map((e) => [e.executionId!, e.type.replace("tool_execution_", "")]));
	return started.map((e) => `${e.callId}:${e.name}:${rec.get(e.executionId!) ?? "NO-RECEIPT"}`);
};

describe("B2-F10 — a child that ignores the abort", () => {
	it("holds the program open (like a direct call would); its receipt is recorded when it lands, BEFORE the parent's; a crash in the wait leaves child and parent both tracked", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const applied: string[] = [];
		const dir = mkdtempSync(join(tmpdir(), "f10-live-"));
		const agent = createAgent({ model: "faux", adapter: createFauxProvider(script), tools: [], extensions: [createProgramExtension({ timeoutMs: 60 }), hideTools(setup(gate, applied))], store: new SessionStore(dir) });
		const session = await agent.session({ id: "s" });
		const events: Event[] = [];
		const running = (async () => { for await (const ev of session.run("go")) events.push(ev); })();
		await new Promise((r) => setTimeout(r, 400)); // well past the program's own time budget (60 ms)

		// T1: the script is over, the remote write is still in flight: the run has NOT ended and nothing is falsely closed
		expect(events.some((e) => e.type === "terminal")).toBe(false);
		expect(records(dir)).toEqual(["p1:program:NO-RECEIPT", "p1/1:step:succeeded", "p1/2:stubborn:NO-RECEIPT"]);
		const crashed = mkdtempSync(join(tmpdir(), "f10-crash-"));
		cpSync(dir, crashed, { recursive: true, filter: (s) => !/\.lock$|\.lock\//.test(s) });

		// T2: the write lands: the child is receipted first, then the program
		release(); await running;
		expect(applied).toEqual(["stubborn-landed"]);
		expect(records(dir)).toEqual(["p1:program:failed", "p1/1:step:succeeded", "p1/2:stubborn:succeeded"]);
		const order = events.filter((e) => e.type === "tool_execution_succeeded" || e.type === "tool_execution_failed").map((e) => (e as { callId: string }).callId);
		expect(order.indexOf("p1/2")).toBeLessThan(order.indexOf("p1"));
		expect(session.uncertainExecutions()).toEqual([]);

		// the crash at T1 (before the write was acknowledged): both are uncertain, resume is blocked, children first
		const resumed = await createAgent({ model: "faux", adapter: createFauxProvider([{ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] }]), tools: [], extensions: [createProgramExtension(), hideTools(setup(Promise.resolve(), []))], store: new SessionStore(crashed) }).session({ id: "s" });
		expect(resumed.uncertainExecutions().map((u) => u.callId).sort()).toEqual(["p1", "p1/2"]);
		await expect((async () => { for await (const _ of resumed.resume()) { /* */ } })()).rejects.toThrow(/blocked/i);
	}, 30_000);
});
