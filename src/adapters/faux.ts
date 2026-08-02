/**
 * L7 — the faux provider: iteration's foundation (mauri ADR-0010).
 *
 * A provider that needs no API key and no network. A `FauxScript` is a
 * turn-by-turn playbook: what the "model" emits. The kernel cannot tell a
 * faux provider from a real one — which is the point: every fixture, every
 * cross-provider matrix entry, and every regression test runs against the
 * same loop that production runs on.
 *
 * Why this is the FIRST adapter: the loop is not written against a mock of
 * the loop — it is written against a fake of the model. The model is the
 * moving part; pinning it down pins down everything downstream (ADR-0001).
 *
 * The TOOL side of a fixture is fake too, but by a different mechanism: a
 * fixture registers defineTool'd handlers that return scripted results.
 * The loop is therefore fully isomorphic between fixture and production —
 * no test-only branch anywhere.
 *
 * `seq`: the script is written WITHOUT seq (a playbook, not a recording).
 * This adapter assigns consecutive seq per stream call; the kernel's
 * EventLog re-asserts monotonicity across sources (ADR-0002).
 */

import type { Adapter, StreamOptions } from "../protocol/adapter";
import type { Event } from "../protocol/events";
import type { EventInput } from "../kernel/event-log";

/** One model turn: the events it emits. Tool results live in fixture tools. */
export interface FauxTurn {
	readonly events: readonly EventInput[];
}

export type FauxScript = readonly FauxTurn[];

export function createFauxProvider(script: FauxScript): Adapter {
	// The script is consumed turn by turn across stream() calls, mirroring a
	// real model answering each new request with the next output. A real
	// provider re-streams the same input on retry; the faux provider instead
	// advances — acceptable because fixtures never combine retries with faux
	// (retry tests use their own throwing adapter).
	let nextTurn = 0;
	return {
		stream(_options: StreamOptions): AsyncIterable<Event> {
			const turn = script[nextTurn];
			nextTurn += 1;
			return {
				async *[Symbol.asyncIterator](): AsyncIterator<Event> {
					// An exhausted script is an empty stream: the loop sees
					// no tool calls and converges on `completed`.
					let seq = 0;
					for (const ev of turn?.events ?? []) {
						yield { ...ev, seq: seq++ } as Event;
					}
				},
			};
		},
	};
}
