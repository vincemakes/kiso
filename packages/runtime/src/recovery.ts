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
	return new Promise<T | typeof ABORTED>((resolve) => {
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
				signal.removeEventListener("abort", onAbort);
				throw err;
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
	readonly #listeners = new Set<() => void>();

	constructor(...sources: readonly AbortSignalLike[]) {
		this.#sources = sources;
		for (const source of sources) {
			if (source.aborted) continue;
			source.addEventListener("abort", () => {
				for (const listener of this.#listeners) listener();
			});
		}
	}

	get aborted(): boolean {
		return this.#sources.some((s) => s.aborted);
	}

	addEventListener(_type: string, listener: (this: AbortSignalStub, ev: unknown) => void): void {
		this.#listeners.add(() => listener.call(this, undefined));
	}

	removeEventListener(_type: string, listener: (this: AbortSignalStub, ev: unknown) => void): void {
		this.#listeners.delete(listener as () => void);
	}
}
