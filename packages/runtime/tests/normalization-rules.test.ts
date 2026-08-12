/**
 * R-H 0.1.49 — the normalization rules gate (ADR-0051 §1 NORMALIZE,
 * ruling R4/C1): the optional fields' absence semantics, declared per
 * variant and pinned at READ time. Absence is legal (validation), and
 * the read paths fill the generation's implied value — derived state is
 * never persisted (invariant ④). The corpus evidence: every gen-D
 * tool_result lacks invocationSeq (100% of the D-real sample); no real
 * D log exercises the request fallback, so that pin is an inline
 * D-shaped log (an ordinary test log, not a generation sample).
 *
 * Accounting (stop clause b): this round's normalization required ZERO
 * core lines — the read-time derivation was already the architecture
 * (recovery-plan.ts invocationSeqOf + the projection's omission path +
 * the driver's undefined-edge guard, run.ts #abandonDraft). The gates
 * below are the §7 row-④ deliverable.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isKisoEvent, projectMessages, type Event } from "@vincemakes/kiso-core";
import { deriveRecoveryPlan, invocationSeqOf } from "../src/recovery-plan.js";

const FIXTURE_DIR = new URL("./fixtures/sessions/", import.meta.url);

describe("R-H 0.1.49 — the NORMALIZE class: absence semantics pinned read-time (R4/C1)", () => {
	it("gen D: tool_result without invocationSeq is legal, projects, derives — the absence is implied", () => {
		const lines = readFileSync(join(FIXTURE_DIR.pathname, "gen-d-0142-real.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean);
		const events = lines.map((line) => JSON.parse(line).event as Event);
		const toolResults = events.filter((e): e is Event & { type: "tool_result" } => e.type === "tool_result");
		expect(toolResults.length).toBeGreaterThan(0);
		for (const t of toolResults) {
			expect(t.invocationSeq).toBeUndefined(); // the D generation's shape
			expect(isKisoEvent(t)).toBe(true); // absence is legal
		}
		const projected = projectMessages(events);
		// The implied value never leaks onto the provider surface.
		for (const m of projected) expect("invocationSeq" in m).toBe(false);
		expect(deriveRecoveryPlan(events, events).kind).toBe("TERMINAL");
	});

	it("the request fallback: invocationSeq absent → the last same-callId call in scope (the implied value)", () => {
		// A D-shaped scope: the request carries no invocationSeq.
		const scope: Event[] = [
			{ seq: 0, type: "user_input", content: "go" },
			{ seq: 3, type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } },
			{ seq: 7, type: "permission_requested", decisionId: "r1", callId: "c1", name: "web_search", input: { query: "k" } },
		];
		const req = scope[2] as Event & { type: "permission_requested" };
		expect(invocationSeqOf(req, scope)).toBe(3); // the old-log identity
		// Present wins — the fallback never fires.
		const withSeq: Event[] = [...scope.slice(0, 2), { ...req, invocationSeq: 9 }];
		expect(invocationSeqOf({ ...req, invocationSeq: 9 } as Event & { type: "permission_requested" }, withSeq)).toBe(9);
	});

	it("decidedBy absence (R10: the direct human) — both shapes are legal, the derivation is identical", () => {
		// The real D-generation shapes (gen-d-0142-real): the decided
		// record carries decidedBy on the policy path; absent = the human.
		const base: Event[] = [
			{ seq: 0, type: "user_input", content: "go" },
			{ seq: 1, type: "tool_call_end", callId: "c1", name: "shell", input: { command: "ls" } },
			{ seq: 2, type: "permission_requested", decisionId: "r1", callId: "c1", name: "shell", input: { command: "ls" } },
			{ seq: 3, type: "permission_decided", decisionId: "d1", callId: "c1", decision: "approved" },
			{ seq: 4, type: "tool_execution_started", executionId: "x1", callId: "c1", name: "shell", input: { command: "ls" } },
			{ seq: 5, type: "tool_execution_succeeded", executionId: "x1", callId: "c1", result: { content: "out\n", isError: false } },
			{ seq: 6, type: "tool_result", callId: "c1", content: "out\n", isError: false, executionId: "x1" },
			{ seq: 7, type: "stop", reason: "end_turn" },
			{ seq: 8, type: "terminal", outcome: { kind: "completed" } },
		];
		const delegated: Event[] = base.map((e, i) =>
			i === 3 ? ({ ...e, decidedBy: "mode:bypass" } as Event) : e,
		);
		for (const e of [base, delegated]) {
			for (const ev of e) expect(isKisoEvent(ev)).toBe(true); // both shapes legal
			expect(deriveRecoveryPlan(e, e).kind).toBe("TERMINAL"); // recovery never consults decidedBy
		}
	});

	it("tags absent → the projection omits the key (project.ts), byte-identically", () => {
		const call: Event = { seq: 0, type: "tool_call_end", callId: "c1", name: "shell", input: { command: "ls" } };
		const withTags: Event[] = [
			call,
			{ seq: 1, type: "tool_result", callId: "c1", content: "x", isError: false, tags: ["keep"] },
		];
		const without: Event[] = [
			call,
			{ seq: 1, type: "tool_result", callId: "c1", content: "x", isError: false },
		];
		const a = projectMessages(withTags);
		const b = projectMessages(without);
		const aTool = a.find((m) => m.role === "tool");
		const bTool = b.find((m) => m.role === "tool");
		expect(aTool).toBeDefined();
		expect((aTool as { tags?: readonly string[] }).tags).toEqual(["keep"]);
		expect("tags" in bTool!).toBe(false); // absence is implied — no key, no undefined
		expect(JSON.stringify(projectMessages(without))).toBe(JSON.stringify(b)); // byte-stable
	});

	it("source / errorKind absent → legal kiso events (the D/E/F generations)", () => {
		expect(isKisoEvent({ seq: 0, type: "tool_result", callId: "c1", content: "x", isError: false })).toBe(true);
		expect(
			isKisoEvent({ seq: 0, type: "tool_execution_failed", executionId: "x1", callId: "c1", error: "boom", safeToRetry: false }),
		).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "text_delta", text: "hi" })).toBe(true);
	});
});
