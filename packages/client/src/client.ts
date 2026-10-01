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
	/** Reconnect backoff for `events()`: first wait and cap, in ms. */
	readonly reconnect?: { readonly initialMs?: number; readonly maxMs?: number };
}

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
}

export interface RunStreamOptions extends Omit<EventsOptions, "until"> {
	readonly source?: WireSource;
	readonly resumeFirst?: boolean;
}

export class SessionClient {
	readonly #options: ClientOptions;
	readonly id: string;

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
		const cap = this.#options.reconnect?.maxMs ?? 5_000;
		for (;;) {
			if (options.signal?.aborted) return;
			let res: Response;
			try {
				res = await this.#request("GET", "events", undefined, {
					headers: { accept: "text/event-stream", "last-event-id": String(lastSeq) },
					...(options.signal !== undefined ? { signal: options.signal } : {}),
				});
			} catch (err) {
				if (options.signal?.aborted) return;
				res = null as never;
				void err;
			}
			if (res !== null) {
				if (res.status !== 200 || res.body === null) await this.#json(res, []); // a refusal is final: forbidden, not_found
				attempt = 0;
				try {
					for await (const frame of readSse(res.body!)) {
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
				} catch {
					// the connection dropped mid-stream — fall through to reconnect
				}
			}
			if (options.signal?.aborted) return;
			attempt += 1;
			const wait = Math.min(cap, initial * 2 ** (attempt - 1));
			options.onReconnect?.(attempt, wait);
			await sleep(wait, options.signal);
		}
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}
