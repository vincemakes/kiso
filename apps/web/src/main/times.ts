import type { SessionStore } from "@vincemakes/kiso-runtime";

/**
 * When each durable event happened. The wire events carry no timestamp; the
 * durable records do (`StoreRecord.ts`), so durations ("thought for N s",
 * a step's time, the footer's duration) are read here and sent as `at`
 * frames. A session's records are read once; events that arrive later are
 * stamped on arrival, which is the moment the store wrote them to within
 * a few milliseconds.
 */
export class TimeIndex {
	readonly #store: SessionStore;
	readonly #bySession = new Map<string, Map<number, number>>();

	constructor(store: SessionStore) {
		this.#store = store;
	}

	at(sessionId: string, seq: number): number {
		let known = this.#bySession.get(sessionId);
		if (known === undefined) {
			known = new Map(this.#store.load(sessionId).map((r) => [r.event.seq, r.ts] as const));
			this.#bySession.set(sessionId, known);
		}
		let ts = known.get(seq);
		if (ts === undefined) {
			ts = Date.now();
			known.set(seq, ts);
		}
		return ts;
	}
}

/** The durable time of every event of a Work, read once and kept while the log has not grown past what was asked for: a replay sends a
 *  terminal event per run, and each one reading the whole log again would cost a Work with many runs seconds to open. */
export class StampCache {
	readonly #store: SessionStore;
	readonly #held = new Map<string, { readonly seq: number; readonly ts: ReadonlyMap<number, number> }>();

	constructor(store: SessionStore) {
		this.#store = store;
	}

	/** The times of the log up to at least `seq` (the log is read again only when it has grown past what is held). */
	upTo(sessionId: string, seq: number): ReadonlyMap<number, number> {
		let held = this.#held.get(sessionId);
		if (held === undefined || held.seq < seq) {
			const records = this.#store.load(sessionId);
			held = { seq: records.at(-1)?.event.seq ?? -1, ts: new Map(records.map((r) => [r.event.seq, r.ts] as const)) };
			this.#held.set(sessionId, held);
		}
		return held.ts;
	}
}
