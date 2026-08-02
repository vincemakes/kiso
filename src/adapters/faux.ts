/**
 * L7 — the faux provider: iteration's foundation (mauri ADR-0010).
 *
 * A provider that needs no API key and no network. A `FauxScript` is a
 * turn-by-turn playbook: what the "model" emits, and what each tool call
 * returns. The kernel cannot tell a faux provider from a real one — which is
 * the point: every fixture, every cross-provider matrix entry, and every
 * regression test runs against the same loop that production runs on.
 *
 * Why this is the FIRST adapter: the loop is not written against a mock of
 * the loop — it is written against a fake of the model. The model is the
 * moving part; pinning it down pins down everything downstream (ADR-0001).
 *
 * `seq`: the script is written WITHOUT seq (a script is a playbook, not a
 * recording). This adapter assigns consecutive seq per stream call; the
 * kernel's EventLog re-asserts monotonicity across sources (ADR-0002).
 */

import type { Adapter, StreamOptions } from "../protocol/adapter";
import type { Event } from "../protocol/events";
import type { ToolResult } from "../tools/tool";

/** One model turn: the events it emits, and how its tool calls resolve. */
export interface FauxTurn {
	/** Events the "model" emits this turn. seq is assigned here, not here. */
	readonly events: readonly Omit<Event, "seq">[];
	/** callId → result, resolved by the kernel when it dispatches the call. */
	readonly toolResults?: Readonly<Record<string, ToolResult>>;
}

export type FauxScript = readonly FauxTurn[];

export function createFauxProvider(script: FauxScript): Adapter {
	return {
		stream(_options: StreamOptions): AsyncIterable<Event> {
			return {
				async *[Symbol.asyncIterator](): AsyncIterator<Event> {
					let seq = 0;
					for (const turn of script) {
						for (const ev of turn.events) {
							yield { ...ev, seq: seq++ } as Event;
						}
					}
				},
			};
		},
	};
}
