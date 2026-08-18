/**
 * SC-1 (the semantic contract audit) — the truncation guard's SIGNAGE,
 * pinned. The guard's header now states its contract in four clauses;
 * clauses 1-3 are already pinned by truncation-guard.test.ts (hold the
 * tool_call_end, release it unchanged on a valid stop, void the whole
 * batch on max_tokens). This file pins the two things the header asserts
 * that no test covered:
 *
 *   clause 4 — a stream that ends with NO stop drops the held calls
 *   entirely, so nothing executes and the kernel voids the malformed turn;
 *
 *   the CONSERVATISM SPLIT — the raw kernel STREAMS (a bare adapter
 *   launches each call the moment its tool_call_end lands, ADR-0024
 *   Amendment 1) while the flagship runtime STOP-GATES (run.ts composes
 *   this wrapper into every run). The second case is the shape where that
 *   difference is a REAL side effect: a truncated turn whose stop arrives
 *   after a gap. Unguarded, the handler has already run by then — that is
 *   the destructive-bug class the guard exists to prevent.
 *
 * EC-1 — THE TRUNCATION CONTRACT AMENDMENT (④). The split above is now
 * OBSOLETE as a safety claim, and the pin below is a declared member of the
 * TRUNCATION CLASS. max_tokens cannot carry a tool call, so a truncated turn
 * never reaches Turn Commit — and a commit-required handler never starts
 * before that commit. The kernel therefore executes nothing on a truncated
 * turn BY ITSELF, on either path; the guard is no longer what stands between
 * a truncated intent and a destructive side effect.
 *
 * What the guard still buys is REPORTING, and it is not nothing: it releases
 * the held batch with `input: null`, so every call is ANSWERED with an
 * honest invalid_input result. Unguarded, the same turn leaves its calls
 * with no results at all — an uncommitted draft the resume voids (⑤).
 * So the amended contract reads: commit-required calls NEVER execute;
 * precommit-safe calls MAY already have executed and that execution is
 * declared harmless; the turn is NOT committed; precommit results never
 * legitimize it.
 *
 * THE DECLARED TRUNCATION CLASS — every member, enumerated:
 *
 *   1. this file, "the split, unguarded" (below): `executed === 1` →
 *      `executed === 0`. The pin said a truncated turn's call had already
 *      run by the time the kernel learned the turn was truncated. The kernel
 *      now refuses to commit, so nothing runs.
 *   2. this file, the two cases added for EC-1 ④ (below): clause 2 of the
 *      amendment — a PRECOMMIT-SAFE call on a truncated turn, bare vs
 *      guarded. Nothing moved here; the clause had no pin at all, and a
 *      contract clause without one is how `concurrencySafe` became fiction.
 *   3. `packages/core/tests/execution-gate.test.ts`, the max_tokens case:
 *      same inversion as (1), at the kernel's own boundary. (Its two
 *      siblings there — refusal and end_turn — are structural-compatibility
 *      cases, not truncation; they belong to the scheduler-timing class the
 *      ① commit declared, and are named here only so the boundary between
 *      the two classes is not left to the reader.)
 *
 * NOT a member, deliberately: `packages/runtime/tests/truncation-guard.test.ts`.
 * Every assertion in it is byte-unchanged, which is the evidence that the
 * amendment relaxed the CONTRACT'S CLAIM without relaxing the GUARD.
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool, loop, ToolRegistry, type Adapter, type Event, type TerminalEvent } from "@vincemakes/kiso-core";
import { truncationGuard } from "../src/truncation-guard.js";

/** A turn whose tool call is COMPLETE but whose stream never stops — the
 *  malformed shape clause 4 names. */
const NO_STOP_SCRIPT: FauxScript = [
	{
		events: [
			{ type: "tool_call_start", callId: "c1", name: "web_search" },
			{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } },
		],
	},
];

/** An adapter with a REAL gap between events — the streaming launch needs
 *  the stream to still be running when the execution starts (a burst
 *  provider's void lands before the launch ever gets past its decide). */
function delayedProvider(phases: Event[][], gapMs: number): Adapter {
	let phase = 0;
	return {
		stream: async function* () {
			const events = phases[Math.min(phase, phases.length - 1)]!;
			phase += 1;
			for (const ev of events) {
				await new Promise((r) => setTimeout(r, gapMs));
				yield ev;
			}
		},
	} as unknown as Adapter;
}

async function drive(
	adapterFor: (a: Adapter) => Adapter,
	base: Adapter,
	effects?: { readonly precommitSafe?: true; readonly concurrency?: "shared" },
): Promise<{ events: readonly Event[]; executed: number }> {
	let executed = 0;
	const registry = new ToolRegistry();
	registry.register(
		defineTool({
			name: "web_search",
			description: "Search",
			parameters: { type: "object", properties: { query: { type: "string" } } },
			...(effects !== undefined ? { effects } : {}),
			execute: async () => {
				executed += 1;
				return { content: "ok", isError: false };
			},
		}),
	);
	const events: Event[] = [];
	for await (const ev of loop({
		adapter: adapterFor(base),
		model: "faux",
		registry,
		messages: [{ role: "user" as const, content: "do it" }],
	})) {
		events.push(ev);
	}
	return { events, executed };
}

const bare = (a: Adapter): Adapter => a;
const terminalOf = (events: readonly Event[]) => events.filter((e): e is TerminalEvent => e.type === "terminal").at(-1)!;

/** A truncated turn whose stop arrives AFTER a gap — long enough for an
 *  unguarded launch to reach the handler. */
const truncatedPhases = () =>
	[
		[
			{ type: "text_delta", text: "searching", seq: 0 },
			{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" }, seq: 1 },
			{ type: "stop", reason: "max_tokens", seq: 2 },
		],
	] as unknown as Event[][];

describe("SC-1 — the truncation guard's header contract", () => {
	it("clause 4: a stream with NO stop drops the held calls — nothing executes, the turn voids", async () => {
		const { events, executed } = await drive(truncationGuard, createFauxProvider(NO_STOP_SCRIPT));

		// The held tool_call_end is never released: it never reaches the log.
		expect(events.some((e) => e.type === "tool_call_end")).toBe(false);
		expect(executed).toBe(0);
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(false);
		// The kernel voids the malformed turn on its own.
		const outcome = terminalOf(events).outcome;
		expect(outcome.kind).toBe("error");
		if (outcome.kind === "error") expect(outcome.error.code).toBe("invalid_request");
	});

	it("EC-1 (truncation class): unguarded, a truncated turn's call NEVER runs — the kernel itself refuses to commit", async () => {
		const { events, executed } = await drive(bare, delayedProvider(truncatedPhases(), 120));

		// Pre-EC-1 this asserted `executed === 1`: the raw kernel launched at
		// the tool_call_end and the side effect of a TRUNCATED turn happened.
		// The kernel now holds its stop until the stream is exhausted, sees
		// max_tokens cannot carry a call, and never commits — so the handler
		// is never authorized. The destructive-bug class is closed in the
		// KERNEL, not only in the runtime wrapper.
		expect(executed).toBe(0);
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(false);
		// An uncommitted turn leaves no durable stop — the call is a draft.
		expect(events.some((e) => e.type === "stop")).toBe(false);
		expect(terminalOf(events).outcome).toEqual({ kind: "max_tokens" });
	});

	it("EC-1 clause 2 (truncation class): bare, a PRECOMMIT-SAFE call on a truncated turn MAY have run — an honest fact, not a committed one", async () => {
		const { events, executed } = await drive(bare, delayedProvider(truncatedPhases(), 120), {
			precommitSafe: true,
			concurrency: "shared",
		});

		// The certificate says this call is harmless before the turn commits,
		// so the kernel spends it: the read launched during the stream and its
		// receipt is durable. Clause 1's guarantee is about commit-required
		// calls, and this one deliberately is not.
		expect(executed).toBe(1);
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(true);
		expect(events.some((e) => e.type === "tool_execution_succeeded")).toBe(true);
		// Clauses 3 + 4: the turn is STILL not committed — no durable stop —
		// and the receipt does not legitimize it. The terminal is unchanged.
		expect(events.some((e) => e.type === "stop")).toBe(false);
		expect(terminalOf(events).outcome).toEqual({ kind: "max_tokens" });
	});

	it("EC-1 clause 2 (truncation class): GUARDED, the same precommit-safe call never runs — the hold is upstream of the kernel", async () => {
		const { events, executed } = await drive(truncationGuard, delayedProvider(truncatedPhases(), 120), {
			precommitSafe: true,
			concurrency: "shared",
		});

		// This is what the wrapper still buys after the amendment: the call
		// never reaches the loop until the stop is known, so the one case the
		// kernel deliberately allows is the case the guard removes.
		expect(executed).toBe(0);
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(false);
		expect(terminalOf(events).outcome).toEqual({ kind: "max_tokens" });
	});

	it("the split, guarded: the SAME stream executes nothing — the batch is voided as invalid input", async () => {
		const { events, executed } = await drive(truncationGuard, delayedProvider(truncatedPhases(), 120));

		// Held until the stop, then flushed with input: null — the kernel's
		// existing invalid-input denial fails it without executing anything.
		expect(executed).toBe(0);
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(false);
		const results = events.filter((e) => e.type === "tool_result");
		expect(results.length).toBe(1);
		expect(results.every((r) => r.isError && r.errorKind === "invalid_input")).toBe(true);
		// Same verdict as the unguarded arm: the guard changes WHAT RAN, not
		// the turn's outcome.
		expect(terminalOf(events).outcome).toEqual({ kind: "max_tokens" });
	});
});
