// ADR-0038: uncertain belongs to the crash window. A verdict on a call a live run is still executing is refused; a verdict a
// call's late outcome meets is kept: the late receipt and its second tool_result are not written. The fixture is built by hand
// in the order two real sessions were broken in (a verdict on a running shell, then its own outcome): no session log is kept.
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { defineTool, type Event } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { ExecutionLiveError } from "../src/session.js";

const shellCall = { events: [{ type: "tool_call_end", callId: "call-1", name: "slow", input: {} }, { type: "stop", reason: "tool_use" }] };
const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const results = (store: SessionStore, id: string, callId: string) => store.load(id).filter((r) => r.event.type === "tool_result" && (r.event as { callId: string }).callId === callId);

describe("a verdict on a live execution", () => {
	it("is refused while the run executes the call; the call's own result is written once when it ends", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		const slow = defineTool({ name: "slow", description: "slow", parameters: { type: "object" }, execute: async () => (await gate, { content: "real outcome", isError: false }) });
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-vl-")));
		const agent = createAgent({ model: "m", store, systemPrompt: "t", tools: [slow] as never, adapter: createFauxProvider([shellCall, say("Done.")] as never) });
		const session = await agent.session({ id: "s" });
		const done = (async () => { for await (const _ of session.run("go")) void _; })();
		for (let i = 0; i < 200 && !session.log.all.some((e) => e.type === "tool_execution_started"); i++) await new Promise((r) => setTimeout(r, 10));
		const [inFlight] = session.uncertainExecutions(); // the ledger's shape: started, no receipt yet
		expect(inFlight).toBeDefined();
		expect(session.interruptedExecutions(), "nothing here is interrupted: it is running").toEqual([]);
		await expect(session.resolveUncertain(inFlight!.executionId, "abandoned")).rejects.toBeInstanceOf(ExecutionLiveError);
		await expect(session.resolveUncertain(inFlight!.executionId, "rerun")).rejects.toThrow("this action is still running: only an interrupted action takes a verdict");
		release();
		await done;
		const own = results(store, "s", "call-1");
		expect(own).toHaveLength(1);
		expect(own[0]!.event).toMatchObject({ content: "real outcome", isError: false });
		expect(store.load("s").some((r) => r.event.type === "tool_execution_resolved"), "no verdict was recorded").toBe(false);
	});

	it("the crash window still takes it: a started call in a run no process holds is interrupted, and the verdict fills its result", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-vl-")));
		await store.append("s", "r-dead", { seq: 0, type: "user_input", content: "go" } as Event);
		await store.append("s", "r-dead", { seq: 1, type: "tool_call_end", callId: "call-1", name: "slow", input: {} } as Event);
		await store.append("s", "r-dead", { seq: 2, type: "tool_execution_started", executionId: "ex-1", callId: "call-1", name: "slow", input: {} } as Event);
		const agent = createAgent({ model: "m", store, systemPrompt: "t", tools: [], adapter: createFauxProvider([] as never) });
		const session = await agent.session({ id: "s" });
		expect(session.interruptedExecutions().map((u) => u.executionId)).toEqual(["ex-1"]);
		await session.resolveUncertain("ex-1", "abandoned");
		expect(results(store, "s", "call-1")).toHaveLength(1);
		expect(session.uncertainExecutions()).toEqual([]);
	});
});

describe("a late receipt after a verdict", () => {
	it("is not written, nor its second tool_result: one result for the call, and a visible line saying why", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-vl-"));
		copyFileSync(join(import.meta.dirname, "fixtures", "verdict", "verdict-then-late-receipt.jsonl"), join(root, "s.jsonl"));
		const store = new SessionStore(root);
		const agent = createAgent({ model: "m", store, systemPrompt: "t", tools: [], adapter: createFauxProvider([] as never) });
		const session = await agent.session({ id: "s" });
		const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		// the executor's own outcome, arriving after the verdict (what the two broken sessions got next)
		await session.persist("r-live", session.log.append({ type: "tool_execution_succeeded", executionId: "ex-1", callId: "call-1", result: { content: "NO MAIL YET", isError: false } } as never));
		await session.persist("r-live", session.log.append({ type: "tool_result", callId: "call-1", content: "NO MAIL YET", isError: false, executionId: "ex-1" } as never));
		const said = err.mock.calls.map((c) => String(c[0]));
		err.mockRestore();
		const disk = store.load("s").map((r) => r.event.type);
		expect(results(store, "s", "call-1")).toHaveLength(1);
		expect(disk).not.toContain("tool_execution_succeeded");
		expect(said.some((l) => l.includes("tool_execution_succeeded for ex-1") && l.includes("already has a verdict"))).toBe(true);
		expect(said.some((l) => l.includes("a second tool_result for ex-1"))).toBe(true);
	});

	it("verdicts in an old run and in this one leave every other call's result to be written", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-vl-")));
		const put = (runId: string, e: Record<string, unknown>) => store.append("s", runId, e as unknown as Event);
		// an old run: a crash, its verdict and result, ended
		await put("r-old", { seq: 0, type: "user_input", content: "go" });
		await put("r-old", { seq: 1, type: "tool_call_end", callId: "call-old", name: "slow", input: {} });
		await put("r-old", { seq: 2, type: "tool_execution_started", executionId: "ex-old", callId: "call-old", name: "slow", input: {} });
		await put("r-old", { seq: 3, type: "tool_execution_resolved", executionId: "ex-old", callId: "call-old", resolution: "abandoned" });
		await put("r-old", { seq: 4, type: "tool_result", callId: "call-old", content: "abandoned", isError: true, executionId: "ex-old" });
		await put("r-old", { seq: 5, type: "terminal", outcome: { kind: "completed" } });
		// this round: another crash, judged now (the set is rebuilt from the log at load, then kept as it goes)
		await put("r-now", { seq: 6, type: "user_input", content: "again" });
		await put("r-now", { seq: 7, type: "tool_call_end", callId: "call-now", name: "slow", input: {} });
		await put("r-now", { seq: 8, type: "tool_execution_started", executionId: "ex-now", callId: "call-now", name: "slow", input: {} });
		const quick = defineTool({ name: "slow", description: "slow", parameters: { type: "object" }, execute: async () => ({ content: "ok", isError: false }) });
		const twoCalls = { events: [{ type: "tool_call_end", callId: "call-a", name: "slow", input: {} }, { type: "tool_call_end", callId: "call-b", name: "slow", input: {} }, { type: "stop", reason: "tool_use" }] };
		const agent = createAgent({ model: "m", store, systemPrompt: "t", tools: [quick] as never, adapter: createFauxProvider([say("Resumed."), twoCalls, say("Done.")] as never) });
		const session = await agent.session({ id: "s" });
		await session.resolveUncertain("ex-now", "abandoned");
		for await (const _ of session.resume()) void _;
		for await (const _ of session.run("two more")) void _;
		for (const call of ["call-old", "call-now", "call-a", "call-b"]) expect(results(store, "s", call), call).toHaveLength(1);
		expect(store.load("s").filter((r) => r.event.type === "tool_execution_succeeded").map((r) => (r.event as { callId: string }).callId).sort()).toEqual(["call-a", "call-b"]);
	});

	it("a call's own result, with no verdict, is always written", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-vl-")));
		const quick = defineTool({ name: "slow", description: "slow", parameters: { type: "object" }, execute: async () => ({ content: "ok", isError: false }) });
		const agent = createAgent({ model: "m", store, systemPrompt: "t", tools: [quick] as never, adapter: createFauxProvider([shellCall, say("Done.")] as never) });
		const session = await agent.session({ id: "s" });
		for await (const _ of session.run("go")) void _;
		expect(results(store, "s", "call-1")).toHaveLength(1);
		expect(store.load("s").some((r) => r.event.type === "tool_execution_succeeded")).toBe(true);
	});
});
