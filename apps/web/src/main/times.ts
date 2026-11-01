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
