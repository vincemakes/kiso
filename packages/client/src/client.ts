import type {
	AbortReply,
	ApproveReply,
	ResolveUncertainReply,
	RunReply,
	SteerReply,
	SessionState,
	WireError,
	WireErrorCode,
	WireEvent,
	WireInput,
	WireSource,
} from "@vincemakes/kiso-protocol";
import { readSse, type SseFrame } from "./sse.js";

/**
 * The typed client for a hosted kiso session, over the wire protocol.
 *
 * It knows the routes the transport answers under a prefix, the one error
 * shape, and how to keep a stream alive: `events()` reconnects with the
 * last seq it delivered as `Last-Event-ID`, so a client that loses its
 * connection mid-run picks up exactly where it was — the transport's
 * replay-from-seq guarantee, consumed. Browser and Node: global `fetch`,
 * no EventSource, nothing from the runtime.
 */

export interface ClientOptions {
	/** The mount point, e.g. `https://api.example.com/v1/sessions`. */
	readonly baseUrl: string;
	/** Per-request headers — the host's auth. Called on every request. */
	readonly headers?: () => Record<string, string> | Promise<Record<string, string>>;
	/** Injected for tests or non-global environments. Default: globalThis.fetch. */
	readonly fetch?: typeof fetch;
	/** Reconnect backoff for `events()`: first wait and cap, in ms (defaults 250 and 30 000), jittered to 0.5..1 of the step;
	 *  `idleMs`: no frame (event or keepalive comment) for this long and the connection is dead (default 35 000). */
	readonly reconnect?: { readonly initialMs?: number; readonly maxMs?: number; readonly idleMs?: number };
}

/** Where `events()` is: dialing, streaming, waiting to dial again (attempt, and the time of the next try), or turned away for good. */
export type ConnectionState =
	| { readonly kind: "connecting" }
	| { readonly kind: "open" }
	| { readonly kind: "retrying"; readonly attempt: number; readonly nextAt: number }
	| { readonly kind: "refused"; readonly status: number; readonly code: WireErrorCode };

/** A non-2xx reply, carrying the wire's error shape. */
export class ClientError extends Error {
	readonly status: number;
	readonly code: WireErrorCode;
	readonly runId: string | undefined;
	constructor(status: number, error: WireError) {
		super(error.message);
		this.name = "ClientError";
		this.status = status;
		this.code = error.code;
		this.runId = error.runId;
	}
}

/** What `events()` yields: a wire event under its seq, a host frame, or
 *  (0.43.0) the transport's comment — `: open`, `: keepalive` — so a
 *  consumer can tell a quiet stream from a dead one. */
export type ClientEvent =
	| { readonly kind: "event"; readonly event: WireEvent }
	| { readonly kind: "frame"; readonly event: string; readonly data: unknown }
	| { readonly kind: "comment"; readonly comment: string };

export interface EventsOptions {
	/** The last seq already seen; −1 (the default) for everything. */
	readonly after?: number;
	/** Stop the stream. */
	readonly signal?: AbortSignal;
	/** End the stream after this event (e.g. the terminal) — otherwise it
	 *  stays open, reconnecting, until the signal fires. */
	readonly until?: (event: ClientEvent) => boolean;
	/** Called before each reconnect with the attempt number and the wait. */
	readonly onReconnect?: (attempt: number, waitMs: number) => void;
	/** Called on every change of the connection's state. A refusal (a 4xx) is reported here and ends the stream. */
	readonly onState?: (state: ConnectionState) => void;
	/** While true no reconnect is tried (a hidden tab); `retryNow()` or the next check ends the wait. */
	readonly paused?: () => boolean;
}

export interface RunStreamOptions extends Omit<EventsOptions, "until"> {
	readonly source?: WireSource;
	readonly resumeFirst?: boolean;
}

export class SessionClient {
	readonly #options: ClientOptions;
	readonly id: string;
	#wake: (() => void) | null = null;

	/** Cut a sleeping reconnect wait short and dial now (the browser came back online, the tab became visible, a button). */
	retryNow(): void {
		this.#wake?.();
	}

	constructor(options: ClientOptions, sessionId: string) {
		this.#options = options;
		this.id = sessionId;
	}

	#url(action: string, query?: Record<string, string>): string {
		const base = `${this.#options.baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(this.id)}${action === "" ? "" : `/${action}`}`;
		if (query === undefined || Object.keys(query).length === 0) return base;
		return `${base}?${new URLSearchParams(query).toString()}`;
	}

	async #request(method: "GET" | "POST", action: string, body?: unknown, extra: { query?: Record<string, string>; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
		const doFetch = this.#options.fetch ?? globalThis.fetch;
		const headers: Record<string, string> = { ...(await this.#options.headers?.()), ...extra.headers };
		if (body !== undefined) headers["content-type"] = "application/json";
		return doFetch(this.#url(action, extra.query), {
			method,
			headers,
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			...(extra.signal !== undefined ? { signal: extra.signal } : {}),
		});
	}

	async #json<T>(res: Response, okStatuses: readonly number[] = [200, 202]): Promise<T> {
		const text = await res.text();
		let parsed: unknown = null;
		try {
			parsed = text === "" ? null : JSON.parse(text);
		} catch {
			parsed = null;
		}
		if (okStatuses.includes(res.status)) return parsed as T;
		const error: WireError = isWireError(parsed) ? parsed : { code: "internal", message: text || `HTTP ${res.status}` };
		throw new ClientError(res.status, error);
	}

	/** Start a turn; refusals arrive as ClientError (in_flight, open_run, draining, forbidden). */
	async run(input: WireInput, options: { source?: WireSource; resumeFirst?: boolean } = {}): Promise<RunReply> {
		return this.#json<RunReply>(await this.#request("POST", "run", { input, ...options }));
	}

	/** ADR-0057 — a person's input for the live run, admitted at its next
	 *  Safe Admission boundary. Throws `ClientError` with code `idle` (no run
	 *  in flight) or `closed` (the run's ingress sealed): start a run with
	 *  the input instead. A stream names input that was accepted and never
	 *  admitted in an `unadmitted` frame after the run's terminal. */
	async steer(input: WireInput): Promise<SteerReply> {
		return this.#json<SteerReply>(await this.#request("POST", "steer", { input }));
	}

	async resume(): Promise<RunReply> {
		return this.#json<RunReply>(await this.#request("POST", "resume", {}));
	}

	/** Stop the run in flight. A parked run is a REPLY (kind "parked"), not an error. */
	/** ADR-0057 — take back the steers the live run has not admitted yet; `count` is how many. */
	async retract(): Promise<{ readonly runId: string | null; readonly count: number }> {
		return this.#json(await this.#request("POST", "retract", {}));
	}

	async abort(options: { force?: boolean } = {}): Promise<AbortReply> {
		return this.#json<AbortReply>(await this.#request("POST", "abort", options), [200, 409]);
	}

	async approve(decisionId: string, allow: boolean, reason?: string): Promise<ApproveReply> {
		return this.#json<ApproveReply>(await this.#request("POST", "approve", { decisionId, allow, ...(reason !== undefined ? { reason } : {}) }));
	}

	async resolveUncertain(executionId: string, resolution: "rerun" | "abandoned"): Promise<ResolveUncertainReply> {
		return this.#json<ResolveUncertainReply>(await this.#request("POST", "uncertain", { executionId, resolution }));
	}

	async state(): Promise<SessionState> {
		return this.#json<SessionState>(await this.#request("GET", "state"));
	}

	async replay(): Promise<{ readonly events: readonly WireEvent[]; readonly state: SessionState }> {
		return this.#json(await this.#request("GET", "replay"));
	}

	/** One turn on one response (`/run?stream=1`): its events, then the end.
	 *  No reconnect — a dropped connection is the caller's cue to `events()`. */
	async *runStream(input: WireInput, options: RunStreamOptions = {}): AsyncGenerator<ClientEvent, void, undefined> {
		const { source, resumeFirst, after, signal } = options;
		const res = await this.#request(
			"POST",
			"run",
			{ input, ...(source !== undefined ? { source } : {}), ...(resumeFirst !== undefined ? { resumeFirst } : {}), after: after ?? -1 },
			{ query: { stream: "1" }, ...(signal !== undefined ? { signal } : {}) },
		);
		if (res.status !== 200 || res.body === null) await this.#json(res, []); // throws the wire error
		for await (const frame of readSse(res.body!)) {
			const ev = toClientEvent(frame);
			if (ev !== null) yield ev;
		}
	}

	/** Every event after `after`, live, reconnecting with `Last-Event-ID` on
	 *  a dropped connection and never yielding a seq twice. Runs until the
	 *  signal fires or `until` says so. */
	async *events(options: EventsOptions = {}): AsyncGenerator<ClientEvent, void, undefined> {
		let lastSeq = options.after ?? -1;
		let attempt = 0;
		const initial = this.#options.reconnect?.initialMs ?? 250;
		const cap = this.#options.reconnect?.maxMs ?? 30_000;
		const idle = this.#options.reconnect?.idleMs ?? 35_000;
		const report = options.onState ?? (() => {});
		for (;;) {
			if (options.signal?.aborted) return;
			report({ kind: "connecting" });
			// the watchdog: no frame for `idle` aborts this connection, and the loop below dials again
			const conn = new AbortController();
			const forward = (): void => conn.abort();
			options.signal?.addEventListener("abort", forward, { once: true });
			let dog: ReturnType<typeof setTimeout>;
			const feed = (): void => {
				clearTimeout(dog);
				dog = setTimeout(forward, idle);
			};
			feed();
			try {
				const res = await this.#request("GET", "events", undefined, { headers: { accept: "text/event-stream", "last-event-id": String(lastSeq) }, signal: conn.signal });
				if (res.status >= 400 && res.status < 500) {
					try {
						await this.#json(res, []);
					} catch (err) {
						if (err instanceof ClientError) report({ kind: "refused", status: err.status, code: err.code });
					}
					return; // a refusal is final, and now it is said
				}
				if (res.status === 200 && res.body !== null) {
					attempt = 0;
					report({ kind: "open" });
					for await (const frame of readSse(res.body)) {
						feed();
						if (options.signal?.aborted) return;
						const ev = toClientEvent(frame);
						if (ev === null) continue;
						if (ev.kind === "event") {
							if (ev.event.seq <= lastSeq) continue; // the seam: never twice
							lastSeq = ev.event.seq;
						}
						yield ev;
						if (options.until?.(ev) === true) return;
					}
				}
			} catch {
				// the connection dropped or went silent — fall through to reconnect
			} finally {
				clearTimeout(dog!);
				options.signal?.removeEventListener("abort", forward);
			}
			if (options.signal?.aborted) return;
			attempt += 1;
			const wait = (0.5 + Math.random() / 2) * Math.min(cap, initial * 2 ** (attempt - 1));
			options.onReconnect?.(attempt, wait);
			report({ kind: "retrying", attempt, nextAt: Date.now() + wait });
			await this.#nap(wait, options.signal);
			while (options.paused?.() === true && options.signal?.aborted !== true) await this.#nap(1_000, options.signal);
		}
	}

	#nap(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			const done = (): void => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", done);
				this.#wake = null;
				resolve();
			};
			const timer = setTimeout(done, ms);
			this.#wake = done;
			if (signal?.aborted) done();
			else signal?.addEventListener("abort", done, { once: true });
		});
	}
}

export class KisoClient {
	readonly #options: ClientOptions;
	constructor(options: ClientOptions) {
		this.#options = options;
	}
	session(sessionId: string): SessionClient {
		return new SessionClient(this.#options, sessionId);
	}
}

export function createClient(options: ClientOptions): KisoClient {
	return new KisoClient(options);
}

function toClientEvent(frame: SseFrame): ClientEvent | null {
	if (frame.data === undefined) return frame.comment !== undefined ? { kind: "comment", comment: frame.comment } : null; // 0.43.0: the transport's liveness, surfaced
	let data: unknown;
	try {
		data = JSON.parse(frame.data);
	} catch {
		return null;
	}
	if (frame.id !== undefined) return { kind: "event", event: data as WireEvent };
	return { kind: "frame", event: frame.event ?? "message", data };
}

function isWireError(value: unknown): value is WireError {
	return typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string" && typeof (value as { message?: unknown }).message === "string";
}
