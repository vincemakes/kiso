/**
 * the ergonomics batch B4 (pure move) — the recovery support pieces, moved verbatim from
 * session.ts: the open-run gate, the abort sentinel/race wrapper, and the
 * merged abort signal.
 */

import type { AbortSignalLike, AbortSignalStub } from "@vincemakes/kiso-core";
import type { StoreRecord } from "./store.js";

/**
 * The most recent run WITHOUT a terminal, or undefined when every recorded
 * run terminated. Recovery can only drive ONE run to its terminal, so an
 * open run must be the exclusive reason a session refuses new runs (round 4).
 */
export function openRunId(records: readonly StoreRecord[]): string | undefined {
	const terminated = new Set(records.filter((r) => r.event.type === "terminal").map((r) => r.runId));
	for (let i = records.length - 1; i >= 0; i--) {
		const runId = records[i]!.runId;
		if (!terminated.has(runId)) return runId;
	}
	return undefined;
}

/** Sentinel: the signal aborted while the recovery awaited a decision. */
export const ABORTED = Symbol("kiso-resume-aborted");

/** Resolve with the decision, or ABORTED when the signal fires first. */
export async function abortable<T>(promise: Promise<T>, signal: AbortSignalLike): Promise<T | typeof ABORTED> {
	if (signal.aborted) return ABORTED;
	return new Promise<T | typeof ABORTED>((resolve, reject) => {
		const onAbort = (): void => {
			signal.removeEventListener("abort", onAbort);
			resolve(ABORTED);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(err) => {
				// R3: REJECT, do not throw. Throwing here creates a new
				// rejected promise that nobody holds, while the executor
				// above never calls resolve or reject — so the outer promise
				// NEVER SETTLES. Three recovery sites await this, so a
				// decision hook that rejects hung the run and left an
				// unhandled rejection behind it. A hook that throws is a host
				// bug: it fails the run, the tool never runs, and there is no
				// silent allow.
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

/**
 * A signal that fires when ANY source fires — the run's own controller and
 * an optional external signal (the CLI's Ctrl+C, a fixture's flip).
 */
export class MergedSignal implements AbortSignalStub {
	readonly #sources: readonly AbortSignalLike[];
	/** R5: the ORIGINAL listeners, by identity. The previous Set held
	 *  WRAPPERS while `removeEventListener` deleted the original, so
	 *  removal never removed anything and every listener ever added fired
	 *  for the life of the run. */
	readonly #listeners = new Set<(this: AbortSignalStub, ev: unknown) => void>();
	/** R5: `aborted` is a TRANSITION, not a stream. Two sources aborting
	 *  fired every listener twice. */
	#fired = false;
	/** R5: the source subscriptions, released on the transition — they
	 *  were never released at all. */
	#cleanups: (() => void)[] = [];

	constructor(...sources: readonly AbortSignalLike[]) {
		this.#sources = sources;
		for (const source of sources) {
			if (source.aborted) continue;
			const onSource = (): void => this.#fire();
			source.addEventListener("abort", onSource, { once: true });
			this.#cleanups.push(() => source.removeEventListener("abort", onSource));
		}
	}

	/** One transition: latch, release the sources, then call each listener
	 *  once. Clearing the set before the calls is what honours `once` for
	 *  every listener without tracking the flag per listener — after the
	 *  one transition there is nothing left to fire a second time. */
	#fire(): void {
		if (this.#fired) return;
		this.#fired = true;
		for (const cleanup of this.#cleanups) cleanup();
		this.#cleanups = [];
		const listeners = [...this.#listeners];
		this.#listeners.clear();
		for (const listener of listeners) listener.call(this, undefined);
	}

	get aborted(): boolean {
		return this.#fired || this.#sources.some((s) => s.aborted);
	}

	addEventListener(_type: string, listener: (this: AbortSignalStub, ev: unknown) => void, _options?: { once?: boolean }): void {
		// A listener added AFTER the transition never fires, which is what a
		// real AbortSignal does — the event is the transition. Callers read
		// `aborted` for the state; `abortable` checks it before it ever
		// subscribes, which is the guard that makes this safe.
		if (this.#fired) return;
		this.#listeners.add(listener);
	}

	removeEventListener(_type: string, listener: (this: AbortSignalStub, ev: unknown) => void): void {
		this.#listeners.delete(listener);
	}
}
