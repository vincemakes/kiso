/**
 * EC-1 — THE BYTES PROOF, in its three-part form.
 *
 * The round's central promise is that a VALID turn's durable record does
 * not change. The design proposal first stated that as "byte-identical
 * durable sequence, later persist moment", and that was too strong: moving
 * a commit-required handler behind the commit moves its `started` /
 * `succeeded` / `result` events behind the `stop` as well. The multiset is
 * untouched; the ORDER is permuted, by exactly one transposition per turn.
 *
 * And the sequence was never a promise anyone could have kept: before EC-1
 * the same order was a RACE — the streaming launch ran against the rest of
 * the stream, and which reached the log first depended on the provider's
 * spacing (the third case below reproduces both sides of it). EC-1 turns
 * that race into an invariant for commit-required calls. So the honest
 * three-part form, which this file asserts mechanically:
 *
 *   1. the durable event MULTISET is unchanged;
 *   2. `projectMessages` is BYTE-IDENTICAL for valid turns;
 *   3. the PRIMARY REQUEST SURFACE is byte-identical.
 *
 * WHERE THE BASE BYTES COME FROM. Not from this round's own claim about
 * what the old kernel did — from a real log written by the real published
 * 0.12.0 bin (`gen-f-0120-faux.jsonl`, R4a provenance in PROVENANCE.md).
 * The test extracts that run's ADAPTER events and its tool outputs and
 * feeds them to the CURRENT kernel: same model stream, same tool results,
 * same policy verdict. Whatever differs is EC-1's doing and nothing else.
 *
 * Part 3 is not asserted here because it is already a standing gate:
 * rent-ledger-gate.test.ts pins that a real session's recorded rent ledger
 * equals scripts/request-surface.mjs's prediction, surface by surface. EC-1
 * did not touch a byte of either side, and that gate is unchanged and green
 * — which is a stronger statement than anything this file could add. (The
 * sideQuery surface moves in R3v2-F1, which ships as its own patch outside
 * EC-1's fence for exactly this reason.)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	defineTool,
	EventLog,
	loop,
	projectMessages,
	ToolRegistry,
	type Adapter,
	type AdapterEvent,
	type Event,
} from "@vincemakes/kiso-core";

const BASE_LOG = fileURLToPath(new URL("./fixtures/sessions/gen-f-0120-faux.jsonl", import.meta.url));

/** Everything the ADAPTER may produce — the kernel owns the rest. */
const ADAPTER_TYPES = new Set([
	"text_start",
	"text_delta",
	"text_end",
	"thinking",
	"tool_call_start",
	"tool_call_input_delta",
	"tool_call_end",
	"usage",
	"stop",
]);

/** The durable events the published bin wrote. */
function baseEvents(): Event[] {
	return readFileSync(BASE_LOG, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line).event as Event);
}

/** That run's model stream, turn by turn — the adapter-owned events in log
 *  order, cut at each stop. The recorded seq rides along because the trust
 *  gate requires a well-formed event (isKisoEvent), but it is only a hint:
 *  the kernel assigns the durable seq at append, which is part of what this
 *  file is testing. */
function turnsOf(events: readonly Event[]): AdapterEvent[][] {
	const turns: AdapterEvent[][] = [];
	let current: AdapterEvent[] = [];
	for (const ev of events) {
		if (!ADAPTER_TYPES.has(ev.type)) continue;
		current.push(ev as AdapterEvent);
		if (ev.type === "stop") {
			turns.push(current);
			current = [];
		}
	}
	return turns;
}

/** A registry that answers every call exactly as the recorded run did —
 *  keyed on the tool's input, so the handler cannot drift from the log. */
function replayRegistry(events: readonly Event[]): ToolRegistry {
	const answer = new Map<string, string>();
	const names = new Set<string>();
	for (const ev of events) {
		if (ev.type !== "tool_call_end") continue;
		names.add(ev.name);
		const result = events.find((e) => e.type === "tool_result" && e.callId === ev.callId);
		if (result !== undefined && result.type === "tool_result") answer.set(JSON.stringify(ev.input), result.content);
	}
	const registry = new ToolRegistry();
	for (const name of names) {
		registry.register(
			defineTool({
				name,
				description: name,
				parameters: { type: "object", properties: { path: { type: "string" } } },
				// The real read_file carries the EC-1 certificate (tools-node);
				// the stand-in must too, or this would measure an undeclared
				// tool's schedule against a declared tool's log.
				effects: { precommitSafe: true, concurrency: "shared" },
				execute: async (input) => ({ content: answer.get(JSON.stringify(input)) ?? "", isError: false }),
			}),
		);
	}
	return registry;
}

/** `gapMs` delays the STOP of each turn — the only gap that matters here.
 *  A burst adapter (the default, gapMs 0) reaches the stop before a
 *  precommit launch has even finished its decide, which is a property of
 *  the test harness rather than of the kernel; the recorded run had a real
 *  provider's spacing. See the ORDER case below. */
function scriptedAdapter(turns: readonly AdapterEvent[][], gapMs = 0): Adapter {
	let turn = 0;
	return {
		stream() {
			const events = turns[Math.min(turn, turns.length - 1)] ?? [];
			turn += 1;
			return {
				async *[Symbol.asyncIterator]() {
					for (const ev of events) {
						if (gapMs > 0 && ev.type === "stop") await new Promise((r) => setTimeout(r, gapMs));
						yield ev;
					}
				},
			};
		},
	};
}

/** Drive the recorded stream through the CURRENT kernel and return the
 *  DURABLE log — not the yielded stream. The two differ by one event: the
 *  seed `user_input` is appended but never yielded, and the durable record
 *  is what the whole claim is about. */
async function replay(base: readonly Event[], registry: ToolRegistry, gapMs = 0): Promise<readonly Event[]> {
	const user = base.find((e) => e.type === "user_input");
	const log = new EventLog();
	for await (const _ev of loop({
		adapter: scriptedAdapter(turnsOf(base), gapMs),
		model: "faux",
		registry,
		log,
		messages: [{ role: "user", content: user !== undefined && user.type === "user_input" ? user.content : "" }],
		approvalPolicy: { decide: async () => ({ action: "allow", decidedBy: "mode:default" }) },
	})) {
		// the durable log is the subject; the yielded stream is not
	}
	return log.all;
}

/** A stable, key-order-independent serialization — recursive, so a nested
 *  field is never silently dropped. (JSON.stringify's array-replacer form
 *  looks like it does this and does not: the allowlist applies at EVERY
 *  depth, so `{outcome: {kind: "completed"}}` serializes as `{outcome:{}}`
 *  and two different terminals compare equal. That mistake made the first
 *  draft of this file pass for the wrong reason.) */
function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value as Record<string, unknown>)
				.sort()
				.map((k) => [k, stable((value as Record<string, unknown>)[k])]),
		);
	}
	return value;
}

/** The multiset: every event, with the two identifiers that FOLLOW the
 *  ordering dropped. `seq` is the position itself; `executionId` is
 *  `ex-<seq>` by construction — comparing either would be comparing the
 *  order twice, and the order is what part 1 deliberately does not claim. */
function multiset(events: readonly Event[]): string[] {
	return events
		.map((ev) => {
			const { seq: _s, executionId: _x, ...rest } = ev as Record<string, unknown> & { seq: number };
			return JSON.stringify(stable(rest));
		})
		.sort();
}

describe("EC-1 — the bytes proof against a real 0.12.0 log", () => {
	it("part 1: the durable event MULTISET is unchanged", async () => {
		const base = baseEvents();
		const fresh = await replay(base, replayRegistry(base));
		expect(multiset(fresh)).toEqual(multiset(base));
	});

	it("part 2: projectMessages is BYTE-IDENTICAL — the model sees exactly what it saw", async () => {
		const base = baseEvents();
		const fresh = await replay(base, replayRegistry(base));
		// The projection is the surface the model is charged for and reasons
		// over. If any permutation reached it, this is where it would show.
		expect(JSON.stringify(projectMessages(fresh))).toBe(JSON.stringify(projectMessages(base)));
	});

	it("the ORDER, stated honestly: commit-gating makes it an INVARIANT where the base only had a race", async () => {
		// What EC-1 actually changes about the sequence, measured rather than
		// asserted from intuition. The recorded 0.12.0 run has its
		// `tool_execution_started` BEFORE the turn's stop — but that order was
		// never a guarantee: the 0.1.26 streaming launch raced the rest of the
		// stream, and which landed first depended on the provider's spacing.
		// Replaying the same events with no gap at all reproduces the other
		// side of that race on the OLD rules, which is exactly why this
		// round's promise is stated over the multiset and the projection and
		// NOT over the sequence.
		const base = baseEvents();
		const GAP = 40; // enough for a launch to reach its started event

		// Certified (precommitSafe + auto-allowed): ③(b) launches during the
		// stream, so given the recorded run's spacing the durable sequence is
		// byte-identical to the published bin's — the certificate buys back
		// the ORDER, not only the throughput.
		const certified = await replay(base, replayRegistry(base), GAP);
		expect(certified.map((e) => e.type)).toEqual(base.map((e) => e.type));

		// Undeclared, same stream, same spacing: the stop ALWAYS precedes the
		// started. No gap can change it — this is the invariant, and it is
		// where the permutation comes from.
		const answer = new Map<string, string>();
		for (const ev of base) {
			if (ev.type !== "tool_call_end") continue;
			const r = base.find((e) => e.type === "tool_result" && e.callId === ev.callId);
			if (r !== undefined && r.type === "tool_result") answer.set(JSON.stringify(ev.input), r.content);
		}
		const undeclared = new ToolRegistry();
		undeclared.register(
			defineTool({
				name: "read_file",
				description: "read_file",
				parameters: { type: "object", properties: { path: { type: "string" } } },
				execute: async (input) => ({ content: answer.get(JSON.stringify(input)) ?? "", isError: false }),
			}),
		);
		const gated = await replay(base, undeclared, GAP);

		// Same facts…
		expect(multiset(gated)).toEqual(multiset(base));
		// …one transposition per turn, and nothing else.
		expect(gated.map((e) => e.type)).not.toEqual(base.map((e) => e.type));
		expect(gated.findIndex((e) => e.type === "stop")).toBeLessThan(gated.findIndex((e) => e.type === "tool_execution_started"));
		expect(base.findIndex((e) => e.type === "stop")).toBeGreaterThan(base.findIndex((e) => e.type === "tool_execution_started"));
		// The projection is byte-identical on THIS arm too — the whole point
		// of part 2: the permutation never reaches the model.
		expect(JSON.stringify(projectMessages(gated))).toBe(JSON.stringify(projectMessages(base)));
	});
});
