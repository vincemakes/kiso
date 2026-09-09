/**
 * LT-1 — the stream watchdog (kiso-doc/kiso-lt1-mini-spec-2026-09-09.md).
 *
 * The third guard beside `truncationGuard` and `traceGuard`: it wraps the
 * adapter's `stream()` so that a request whose events STOP ARRIVING is
 * ended rather than waited on forever. Before this, a model stream that
 * went silent — a hung socket, an upstream that stopped writing without
 * closing — held the run open until a human pressed esc; the 0.31.0
 * review filed it as the one long-task hazard nothing handled.
 *
 * The rule is per EVENT, not per request: a long think that keeps
 * streaming is never tripped, a socket that stops is tripped `idleMs`
 * after its last byte. On a trip the guard aborts the UNDERLYING request
 * through a controller it owns (combined with the caller's signal, so
 * esc still wins) and throws a retryable `network` StructuredError. From
 * there the kernel's existing mid-stream retry does the rest: the
 * attempt is voided (`model_output_abandoned` with this reason), the
 * request is retried with backoff, and when the budget is spent the run
 * ends in the error terminal the CLI prints (OR-5). Nothing new is
 * written to the log; the kernel is untouched.
 *
 * `idleMs` ≤ 0 (or absent) returns the adapter itself: the guard is
 * declared off, not silently ignored.
 */

import type { Adapter, AdapterEvent, StreamOptions, StructuredError } from "@vincemakes/kiso-core";

/** The default: 120 s between events. The ChatGPT backend at a high effort
 *  can think without writing (no reasoning summaries are requested), and
 *  no measured bound exists for an `ultra` turn — 120 s is the order of
 *  magnitude the reference implementation allows a whole request, applied
 *  here per event: stricter where it matters, looser where it should be.
 *  A knob (`streamIdleMs` on the profile) because the first dogfood may
 *  move it. */
export const DEFAULT_STREAM_IDLE_MS = 120_000;

export function idleGuard(adapter: Adapter, idleMs: number | undefined): Adapter {
	if (idleMs === undefined || !(idleMs > 0)) return adapter;
	return {
		stream: (options) => guardStream(adapter, options, idleMs),
	};
}

/** The error the kernel receives on a trip — the same shape the adapters
 *  produce for a connection failure, so the retry authority (ADR-0005)
 *  treats a stall exactly like a dropped socket. */
export function stalledError(idleMs: number, elapsedMs: number): StructuredError {
	return {
		code: "network",
		retryable: true,
		message: `stream stalled: no event for ${Math.round(idleMs / 1000)}s (${Math.round(elapsedMs / 1000)}s into the request)`,
	};
}

/** The caller's abort, as the kernel's catch reads it: an error NAMED
 *  AbortError with the signal set — `aborted by user`, never a stall. */
function abortError(): Error {
	const err = new Error("stream aborted by the caller");
	err.name = "AbortError";
	return err;
}

async function* guardStream(adapter: Adapter, options: StreamOptions, idleMs: number): AsyncIterable<AdapterEvent> {
	const own = new AbortController();
	const caller = options.signal;
	// the caller's abort (esc) reaches the adapter through OUR controller —
	// one signal goes down — and it also settles OUR wait at once: an
	// adapter that ignores its signal (a stub, a transport that only
	// notices on the next write) must not turn the caller's abort into a
	// stall by keeping the guard waiting until the idle timer fires.
	let rejectOnCallerAbort: (err: unknown) => void = () => undefined;
	const callerAborted = new Promise<never>((_, reject) => {
		rejectOnCallerAbort = reject;
	});
	callerAborted.catch(() => undefined); // settled only when raced; never an unhandled rejection
	const onCallerAbort = (): void => {
		own.abort();
		rejectOnCallerAbort(abortError());
	};
	if (caller?.aborted === true) onCallerAbort();
	else caller?.addEventListener("abort", onCallerAbort, { once: true });

	const iterator = adapter.stream({ ...options, signal: own.signal })[Symbol.asyncIterator]();
	const started = Date.now();
	let tripped = false;
	try {
		for (;;) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const stall = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					if (caller?.aborted === true) {
						// the caller gave up first; the silence is theirs, not a stall
						reject(abortError());
						return;
					}
					tripped = true;
					own.abort();
					reject(stalledError(idleMs, Date.now() - started));
				}, idleMs);
			});
			let next: IteratorResult<AdapterEvent>;
			try {
				next = await Promise.race([iterator.next(), stall, callerAborted]);
			} catch (err) {
				// an abort the CALLER asked for is theirs (the kernel reads its
				// own signal and records `aborted by user`); an abort WE caused
				// is the stall, whatever shape the adapter turned it into
				if (tripped && caller?.aborted !== true) throw stalledError(idleMs, Date.now() - started);
				throw err;
			} finally {
				clearTimeout(timer);
			}
			if (next.done) return;
			yield next.value;
		}
	} finally {
		caller?.removeEventListener("abort", onCallerAbort);
		// release the underlying generator whichever way this one ends
		// (a trip, the caller's abort, or the consumer walking away)
		await iterator.return?.().catch(() => undefined);
	}
}
