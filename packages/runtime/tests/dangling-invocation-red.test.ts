/**
 * R-E 0.1.43 — Gap A RED (the dangling invocation): a legal stop with a
 * tool_call_end whose permission events never landed.
 *
 * The window (the review's finding): the truncation guard holds
 * tool_call_end until the stop (runtime/truncation-guard.ts), so the
 * stop lands in the log BEFORE the whole async policy chain drains —
 * a SIGKILL in that window leaves exactly the durable prefix
 * [user_input, tool_call_end, stop] with NO permission_requested,
 * NO permission_decided, NO started, NO result. #recover keys on
 * permission_requested alone (run.ts), so the invocation is invisible
 * to recovery and the continuation re-drives the model from the
 * projection — which carries the assistant message with an unanswered
 * tool_use (kernel/project.ts has no dangling precheck). The provider
 * 400s, and the resume dies with an error terminal.
 *
 * RED (today): the run ends with an error terminal (invalid_request —
 * the provider's 400), the call never executes, and the provider WAS
 * asked with the dangling pair. GREEN (the fix): the UNDECIDED
 * invocation re-enters the approval pipeline on recovery — re-decided,
 * executed, and the provider is only ever called after the pair closed.
 * Only a durable permission_decided authorizes an effect.
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Adapter, type Event, type Message, type Tool } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

/** A provider that refuses the dangling shape exactly like the OpenAI-family
 *  API: an assistant message with a tool_use whose tool message never
 *  follows is an invalid_request — the resume must never send it. */
function danglingRejectingProvider(): { adapter: Adapter; requests: readonly Message[][] } {
	const requests: Message[][] = [];
	const adapter: Adapter = {
		stream(options) {
			requests.push(options.messages as Message[]);
			return {
				async *[Symbol.asyncIterator]() {
					const dangling = options.messages.some(
						(m) => m.role === "assistant" && m.blocks.some((b) => b.type === "tool_use"),
					);
					if (dangling) {
						const err = new Error(
							"Invalid parameter: messages with role 'assistant' must have tool_calls followed by tool messages",
						) as Error & { code: string; retryable: boolean };
						err.code = "invalid_request";
						err.retryable = false;
						throw err;
					}
					yield { type: "stop", reason: "end_turn", seq: 0 };
				},
			};
		},
	};
	return { adapter, requests };
}

/** A tool whose side effect is a marker file — observable across the run. */
function markerTool(markerPath: string): Tool<{ query: string }> {
	return defineTool<{ query: string }>({
		name: "web_search",
		description: "Search",
		parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		execute: async (input) => {
			writeFileSync(markerPath, input.query, "utf8");
			return { content: `results for ${input.query}`, isError: false };
		},
	});
}

describe("R-E 0.1.43 Gap A (RED): a committed turn's undecided invocation", () => {
	it("resume never re-drives the provider with the dangling tool_use — the UNDECIDED call is re-decided and executed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-ga-red-"));
		const marker = join(dir, "side-effect.txt");
		const store = new SessionStore(dir);
		// The durable prefix a SIGKILL leaves when the stop landed but the
		// policy chain's decision never drained: the user turn, the call,
		// the stop — and NOTHING else.
		await store.append("s", "r1", { seq: 0, type: "user_input", content: "go" });
		await store.append("s", "r1", { seq: 1, type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } });
		await store.append("s", "r1", { seq: 2, type: "stop", reason: "tool_use" });
		store.closeAll();

		const { adapter, requests } = danglingRejectingProvider();
		const agent = createAgent({ model: "faux", store: new SessionStore(dir), tools: [markerTool(marker)], adapter });
		const session = await agent.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.resume()) events.push(ev);

		// GREEN: the run completes — the 400 never fires, the invocation is
		// re-decided, executed, and its result is durable.
		expect(events.find((e) => e.type === "terminal")?.outcome.kind).toBe("completed");
		expect(existsSync(marker)).toBe(true);
		// Every provider request is pair-clean — the dangling tool_use never
		// leaves the projection.
		for (const request of requests) {
			expect(
				request.filter((m) => m.role === "assistant").some((m) => m.blocks.some((b) => b.type === "tool_use")),
			).toBe(false);
		}
		const records = new SessionStore(dir).load("s");
		expect(records.some((r) => r.event.type === "permission_decided")).toBe(true);
		expect(records.some((r) => r.event.type === "tool_result")).toBe(true);
	});
});
