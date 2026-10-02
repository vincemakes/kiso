/**
 * ADR-0058 3d (D6): a run may carry its own turn budget — the wrap-up run a
 * background child gets after its budget is spent is limited to one model
 * request, whatever the session's own limit is.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { defineTool, type Event } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

const CALL = (id: string) => ({ events: [{ type: "tool_call_end" as const, callId: id, name: "look", input: {} }, { type: "stop" as const, reason: "tool_use" as const }] });

describe("ADR-0058 3d — a per-run turn budget", () => {
	it("run(input, { maxTurns: 1 }) ends max_turns after one request; the next run has no such limit", async () => {
		const look = defineTool({ name: "look", description: "L", parameters: { type: "object" }, execute: async () => ({ content: "seen", isError: false }) });
		const done = { events: [{ type: "text_delta" as const, text: "answer" }, { type: "stop" as const, reason: "end_turn" as const }] };
		const session = await createAgent({ model: "faux", store: new SessionStore(mkdtempSync(join(tmpdir(), "kiso-maxturns-"))), tools: [look], adapter: createFauxProvider([CALL("a"), CALL("b"), CALL("c"), done]) }).session({ id: "s" });
		const first: Event[] = [];
		for await (const ev of session.run("go", { maxTurns: 1 })) first.push(ev);
		expect(first.at(-1)).toMatchObject({ type: "terminal", outcome: { kind: "max_turns", turns: 1 } });
		const second: Event[] = [];
		for await (const ev of session.run("again")) second.push(ev);
		expect(second.at(-1)).toMatchObject({ type: "terminal", outcome: { kind: "completed" } });
	});
});
