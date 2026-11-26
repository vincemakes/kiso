/**
 * #24 — an abort between a persisted call's durable start and its execute
 * is a PRECONDITION refusal, the same as the kernel's own path.
 *
 * The kernel answers "aborted before execution" with errorKind
 * "precondition" (nothing ran). The runtime's persisted-approval path —
 * a call whose approval is durable, executed at resume without asking the
 * model again — said "fatal" for the same case, so a host could not tell
 * "never ran" from a crash, and the non-idempotent note ("its side effects
 * may have partially applied") rode a result for which nothing ran.
 * Async fsync widened the window, so hosts reach this path more often.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter, AdapterEvent, Event } from "@vincemakes/kiso-core";
import { ABORTED_BEFORE_EXECUTION, createAgent, SessionStore } from "../src/index.js";

const answering: Adapter = {
	stream: async function* (): AsyncIterable<AdapterEvent> {
		yield { seq: 0, type: "text_delta", text: "done" };
		yield { seq: 0, type: "stop", reason: "end_turn" };
	},
};

describe("#24 — aborted before execution on the persisted path", () => {
	it("red: errorKind fatal with the non-idempotent note / green: precondition, the kernel's words, the tool never runs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-24-"));
		const seed = new SessionStore(dir);
		let seq = 0;
		const put = (e: Record<string, unknown>) => seed.append("s", "r1", { seq: seq++, ...e } as never);
		await put({ type: "user_input", content: "write it" });
		const callSeq = seq;
		await put({ type: "tool_call_end", callId: "c1", name: "write", input: { text: "x" } });
		await put({ type: "permission_decided", decisionId: "d1", callId: "c1", invocationSeq: callSeq, decision: "approved", decidedBy: "mode:bypass" });
		await put({ type: "stop", reason: "tool_use" });
		await seed.closeAll();

		let ran = 0;
		const write = {
			name: "write",
			description: "writes",
			parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
			execute: async () => {
				ran += 1;
				return { content: "written", isError: false };
			},
		};
		const agent = createAgent({ model: "faux", store: new SessionStore(dir), tools: [write], adapter: answering } as never);
		const session = await agent.session({ id: "s" });
		const run = session.resume();
		for await (const ev of run) {
			// the window: the durable start is out, the handler has not been called
			if ((ev as Event).type === "tool_execution_started") run.abort();
		}
		const log = [...session.log.all];
		await agent.close();

		expect(ran).toBe(0);
		expect(log.some((e) => e.type === "tool_execution_started")).toBe(true);
		const failed = log.find((e) => e.type === "tool_execution_failed") as (Event & { errorKind?: string; error: string }) | undefined;
		expect(failed?.errorKind).toBe("precondition");
		expect(failed?.error).toBe(ABORTED_BEFORE_EXECUTION);
		const result = log.find((e) => e.type === "tool_result" && (e as { callId: string }).callId === "c1") as (Event & { errorKind?: string; content: string; isError: boolean }) | undefined;
		expect(result?.isError).toBe(true);
		expect(result?.errorKind).toBe("precondition");
		expect(result?.content).toBe(ABORTED_BEFORE_EXECUTION);
	});
});
