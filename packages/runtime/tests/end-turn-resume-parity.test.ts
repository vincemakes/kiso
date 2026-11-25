/**
 * 0.42.0 (the review before the release) — END_TURN's durable-prefix parity.
 *
 * The sentence this file exists for: the same durable prefix yields the
 * same next step on the fresh path and on a cold resume. A tool result
 * tagged END_TURN had been honoured only at the tail of a settled batch,
 * so a run resumed after a crash between that result and the next
 * request (CONTINUE_MODEL re-enters the loop at its head) asked the model
 * once more. Both crash windows are RED on the tail-only check.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, END_TURN, type Event } from "@vincemakes/kiso-core";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "../src/index.js";

const terminalOf = (events: readonly Event[]) => events.find((e) => e.type === "terminal") as (Event & { type: "terminal" }) | undefined;

/** An agent whose model would answer if asked — the assertion is that it is not. */
function agentOn(store: SessionStore, ran: { count: number }, calls: { count: number }) {
	const base = createFauxProvider([{ events: [{ type: "text_delta" as const, text: "asked again" }, { type: "stop" as const, reason: "end_turn" as const }] }]);
	const ask = defineTool({
		name: "ask",
		description: "asks the person; its result ends the turn",
		parameters: { type: "object", properties: { q: { type: "string" } } },
		execute: async () => {
			ran.count += 1;
			return { content: "asked", isError: false, tags: [END_TURN] };
		},
	});
	return createAgent({
		model: "faux",
		store,
		tools: [ask],
		adapter: { stream: (o: Parameters<typeof base.stream>[0]) => { calls.count += 1; return base.stream(o); } },
	});
}

async function seed(dir: string, withResult: boolean): Promise<void> {
	const store = new SessionStore(dir);
	await store.append("s", "r1", { seq: 0, type: "user_input", content: "go" });
	await store.append("s", "r1", { seq: 1, type: "tool_call_end", callId: "c1", name: "ask", input: { q: "which?" } });
	await store.append("s", "r1", { seq: 2, type: "stop", reason: "tool_use" });
	await store.append("s", "r1", { seq: 3, type: "tool_execution_started", executionId: "ex-3", callId: "c1", name: "ask", input: { q: "which?" } });
	await store.append("s", "r1", { seq: 4, type: "tool_execution_succeeded", executionId: "ex-3", callId: "c1", result: { content: "asked", isError: false }, tags: [END_TURN] });
	if (withResult) await store.append("s", "r1", { seq: 5, type: "tool_result", callId: "c1", content: "asked", isError: false, tags: [END_TURN], executionId: "ex-3" });
	await store.closeAll();
}

describe("0.42.0: END_TURN decides the same on a cold resume as on the fresh path", () => {
	it("window A — the tagged tool_result is on disk, the terminal is not: resume completes with ZERO requests", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-endturn-"));
		await seed(dir, true);
		const ran = { count: 0 };
		const calls = { count: 0 };
		const session = await agentOn(new SessionStore(dir), ran, calls).session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.resume()) events.push(ev);
		expect(calls.count).toBe(0); // the model was NOT asked again
		expect(ran.count).toBe(0); // the tool did NOT run again
		expect(terminalOf(events)?.outcome.kind).toBe("completed");
	});

	it("window B — only the tagged receipt is on disk: the tool_result is repaired WITH the tag, then ZERO requests", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-endturn-"));
		await seed(dir, false);
		const ran = { count: 0 };
		const calls = { count: 0 };
		const session = await agentOn(new SessionStore(dir), ran, calls).session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.resume()) events.push(ev);
		const repaired = events.find((e) => e.type === "tool_result") as (Event & { type: "tool_result" }) | undefined;
		expect(repaired).toMatchObject({ callId: "c1", content: "asked", isError: false });
		expect(repaired?.tags ?? []).toContain(END_TURN);
		expect(calls.count).toBe(0);
		expect(ran.count).toBe(0);
		expect(terminalOf(events)?.outcome.kind).toBe("completed");
	});

	it("the boundary — a NEW run after a turn ended by END_TURN asks the model (the old result is behind user_input)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-endturn-"));
		await seed(dir, true);
		const ran = { count: 0 };
		const calls = { count: 0 };
		const agent = agentOn(new SessionStore(dir), ran, calls);
		const session = await agent.session({ id: "s" });
		for await (const _ of session.resume()) void _;
		expect(calls.count).toBe(0);
		const events: Event[] = [];
		for await (const ev of session.run("and now?")) events.push(ev);
		expect(calls.count).toBe(1); // the next run is a conversation again
		expect(terminalOf(events)?.outcome.kind).toBe("completed");
	});
});
