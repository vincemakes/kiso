/**
 * L2 — the EventLog: the kernel's single truth (ADR-0002).
 *
 * Every event the loop yields passes through here. `seq` is assigned HERE,
 * and only here: an adapter's seq is a "stream-local ordering hint" that this
 * log re-asserts, because the loop interleaves adapter events with its own
 * (tool_result, terminal). One allocator, monotonic by construction — there
 * is no second copy of history to desync, and a trajectory is the replay of
 * seq 0..N.
 */

import type { Event } from "../protocol/events";

/**
 * An event without its seq — what producers emit.
 *
 * Distribution note: conditional types only distribute over a BARE type
 * parameter — `Event extends unknown ? Omit<Event, "seq"> : never` does NOT
 * distribute (Event is a concrete alias, not a parameter) and collapses the
 * union to its common keys. Wrapping the union in a generic parameter is
 * what keeps each variant's own fields (callId, outcome, text, ...).
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventInput = DistributiveOmit<Event, "seq">;

export class EventLog {
	readonly #events: Event[] = [];
	#next = 0;

	/**
	 * Append an event; assigns the authoritative seq and returns it.
	 * `seq` is assigned HERE and only here — a producer's seq is a
	 * stream-local hint, never trusted (ADR-0002).
	 */
	append(ev: EventInput): Event {
		const full: Event = { ...ev, seq: this.#next++ };
		this.#events.push(full);
		return full;
	}

	get all(): readonly Event[] {
		return this.#events;
	}

	/** Incremental view for consumers that already saw `seq` and before. */
	since(seq: number): readonly Event[] {
		return this.#events.filter((e) => e.seq >= seq);
	}

	get lastSeq(): number {
		return this.#next - 1;
	}
}
