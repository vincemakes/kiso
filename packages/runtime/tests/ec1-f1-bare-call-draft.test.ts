/**
 * EC-1 finding EC1-F1 (RED) — the BARE TOOL-CALL draft.
 *
 * Gap B (R-E 0.1.43) taught the resume to void "a model output suffix
 * without a committed stop". Its detector, recovery-plan.ts, looks for
 * TEXT: `text_delta` or `thinking` after the last boundary. That is the
 * whole test. So a turn whose entire output was tool calls — no narration,
 * an extremely common real shape — is not seen as a draft at all:
 *
 *   [user_input, tool_call_end]           →  CONTINUE_MODEL
 *
 * and the projection then renders that un-voided `tool_call_end` as an
 * assistant `tool_use` block with NO matching tool result. Every provider
 * rejects that pairing; it is the same 400 family P1/0.1.42 exists to
 * prevent.
 *
 * On base this window was microseconds wide: the stop was persisted the
 * instant it arrived, so a crash had almost no chance to land between the
 * call and the stop. EC-1 ① holds the stop until the stream is exhausted,
 * which widens the window to the WHOLE stream tail — every crash during a
 * tool-calling turn now lands in it, and crash-pair A lands in it BY
 * CONSTRUCTION. The latent bug becomes a routine one, so ⑤ ships with ①.
 *
 * THE FIX: model output is model output. The draft scan counts
 * `tool_call_end` alongside `text_delta`/`thinking`. The `liveAsk`
 * exception is RETAINED, unchanged, as a pre-EC-1 generation-compat rule —
 * see the era note in recovery-plan.ts.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectMessages, type Adapter, type Event, type Message } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { deriveRecoveryPlan } from "../src/recovery-plan.js";

/** seq-numbered prefix builder. */
function prefix(...events: Omit<Event, "seq">[]): Event[] {
	return events.map((e, seq) => ({ ...e, seq }) as Event);
}

describe("EC1-F1 — a bare tool-call suffix with no stop is a DRAFT, not a continuation", () => {
	it("derives ABANDON_DRAFT (pre-fix: CONTINUE_MODEL, leaving a dangling tool_use)", () => {
		const events = prefix(
			{ type: "user_input", content: "go" } as Omit<Event, "seq">,
			{ type: "tool_call_end", callId: "c1", name: "edit_file", input: { path: "a" } } as Omit<Event, "seq">,
		);
		expect(deriveRecoveryPlan(events, events)).toEqual({ kind: "ABANDON_DRAFT", voidFromSeq: 0 });
	});

	it("the text-bearing draft still derives ABANDON_DRAFT (the Gap B behavior is untouched)", () => {
		const events = prefix(
			{ type: "user_input", content: "go" } as Omit<Event, "seq">,
			{ type: "text_delta", text: "I will edit it" } as Omit<Event, "seq">,
			{ type: "tool_call_end", callId: "c1", name: "edit_file", input: { path: "a" } } as Omit<Event, "seq">,
		);
		expect(deriveRecoveryPlan(events, events)).toEqual({ kind: "ABANDON_DRAFT", voidFromSeq: 0 });
	});

	it("GENERATION COMPAT: the pre-EC-1 live-ask pause is still WAIT_PERMISSION, never a draft", () => {
		// A pre-EC-1 log could legally hold [call, request] with no stop: the
		// ask fired mid-stream. That shape must keep re-presenting its ask —
		// the liveAsk clause. EC-1 logs cannot produce it (asks are
		// post-commit), but old sessions on disk still carry it.
		const events = prefix(
			{ type: "user_input", content: "go" } as Omit<Event, "seq">,
			{ type: "tool_call_end", callId: "c1", name: "edit_file", input: { path: "a" } } as Omit<Event, "seq">,
			{
				type: "permission_requested",
				decisionId: "d1",
				callId: "c1",
				invocationSeq: 1,
				name: "edit_file",
				input: { path: "a" },
			} as Omit<Event, "seq">,
		);
		expect(deriveRecoveryPlan(events, events)).toEqual({ kind: "WAIT_PERMISSION", invocationSeq: 1 });
	});

	it("a COMMITTED call (a durable stop follows it) is never a draft", () => {
		const events = prefix(
			{ type: "user_input", content: "go" } as Omit<Event, "seq">,
			{ type: "tool_call_end", callId: "c1", name: "edit_file", input: { path: "a" } } as Omit<Event, "seq">,
			{ type: "stop", reason: "tool_use" } as Omit<Event, "seq">,
		);
		expect(deriveRecoveryPlan(events, events)).toEqual({ kind: "DECIDE_PERMISSION", invocationSeq: 1 });
	});

	it("end to end: the resumed request never carries a tool_use without its result", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-ec1f1-"));
		const store = new SessionStore(dir);
		// Crash-pair A's durable shape: the call is persisted, the stop is not.
		await store.append("s", "r1", { seq: 0, type: "user_input", content: "go" });
		await store.append("s", "r1", {
			seq: 1,
			type: "tool_call_end",
			callId: "c1",
			name: "edit_file",
			input: { path: "a" },
		} as Event);
		store.closeAll();

		const requests: Message[][] = [];
		const adapter: Adapter = {
			stream(options) {
				requests.push(options.messages as Message[]);
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "text_delta", text: "FRESH OUTPUT", seq: 0 };
						yield { type: "stop", reason: "end_turn", seq: 1 };
					},
				};
			},
		};
		const agent = createAgent({ model: "faux", store: new SessionStore(dir), tools: [], adapter });
		const session = await agent.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.resume()) events.push(ev);

		/** Every tool_use block in a message array that has no answering result. */
		const dangling = (msgs: readonly Message[]): string[] => {
			const answered = new Set(msgs.filter((m) => m.role === "tool").map((m) => m.callId));
			return msgs
				.filter((m) => m.role === "assistant")
				.flatMap((m) => m.blocks.filter((b) => b.type === "tool_use").map((b) => b.callId))
				.filter((c) => !answered.has(c));
		};

		// The request the model actually saw on resume.
		expect(requests.length).toBeGreaterThan(0);
		for (const req of requests) expect(dangling(req)).toEqual([]);
		// And the final projection of the whole session, replayed from disk.
		expect(dangling(projectMessages(events))).toEqual([]);
		// The draft was voided by a marker, not by deleting anything: the
		// call's bytes are still on disk, they simply no longer project.
		expect(events.some((e) => e.type === "model_output_abandoned")).toBe(true);
	});
});
