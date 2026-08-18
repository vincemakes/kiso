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

async function drive(adapterFor: (a: Adapter) => Adapter, base: Adapter): Promise<{ events: readonly Event[]; executed: number }> {
	let executed = 0;
	const registry = new ToolRegistry();
	registry.register(
		defineTool({
			name: "web_search",
			description: "Search",
			parameters: { type: "object", properties: { query: { type: "string" } } },
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

	it("the split, unguarded: a truncated turn's call has ALREADY run by the time max_tokens lands", async () => {
		const { events, executed } = await drive(bare, delayedProvider(truncatedPhases(), 120));

		// The raw kernel launched at the tool_call_end — the side effect of a
		// TRUNCATED turn happened. This is the bug the guard exists for.
		expect(executed).toBe(1);
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(true);
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
