import type { IncomingMessage, ServerResponse } from "node:http";
import type { Event } from "@vincemakes/kiso-core";
import { RunClosedError } from "@vincemakes/kiso-runtime";
import type { AbortReply, SessionState, WireError, WireErrorCode, WireFrame, WireInput, WireSource } from "@vincemakes/kiso-protocol";
import { DrainingError, InFlightError, NotRunningError, OpenRunError } from "./errors.js";
import type { SessionService } from "./service.js";
import { type ProjectionOptions, toWireEvent } from "./wire.js";

/**
 * The HTTP + SSE transport over the hosted-session service.
 *
 * A host mounts `handle` in front of its own routes: it answers the agent
 * routes under `prefix` and returns false for everything else. Status codes
 * and framing are decided here, once — the two hosting products had each
 * chosen their own (409 for in-flight in one, an exception in the other;
 * `event:` on every frame in one, none in the other; a keepalive in one).
 *
 *   GET  {prefix}/:id/events     the stream, from ?after or Last-Event-ID
 *   GET  {prefix}/:id            the session snapshot (also /state)
 *   GET  {prefix}/:id/replay     every wire event on the log + the snapshot
 *   POST {prefix}/:id/run        202 { runId } — or the run's own stream with ?stream=1
 *   POST {prefix}/:id/resume     202 { runId } — or the stream with ?stream=1
 *   POST {prefix}/:id/steer      202 { runId } — 409 idle | closed (ADR-0057)
 *   POST {prefix}/:id/abort      200 idle | stopped — 409 parked (who is waited for)
 *   POST {prefix}/:id/approve    200 { needsResume }
 *   POST {prefix}/:id/uncertain  200 { remaining }
 *
 * What the host supplies: `authorize` (REQUIRED — session ownership; there
 * is no default that allows), and optionally `augment` (frames beside a
 * wire event: billing, estimates), `prepareInput` (the product's turn
 * preparation), the projection options and the keepalive period.
 */

export interface HttpHandlerOptions {
	/** The mount point; the session id and the action follow it. Default `/v1/sessions`. */
	readonly prefix?: string;
	/** Session ownership, per request. False → 403, and nothing is opened. */
	readonly authorize: (req: IncomingMessage, sessionId: string) => Promise<boolean> | boolean;
	/** Frames a product adds beside a wire event on the same connection. */
	readonly augment?: (event: Event, sessionId: string) => readonly WireFrame[] | Promise<readonly WireFrame[]>;
	/** 0.43.0 (#4): the host's own frame source. Called once per open
	 *  stream with a `push`; whatever the host pushes — a tool's progress,
	 *  a retry banner — is written on the SAME ordered chain as the wire
	 *  events, so a frame pushed between two events lands between them,
	 *  on `/run?stream=1` and on `GET /events` alike. The returned function
	 *  is called when the stream ends; a push after that is dropped.
	 *  Nothing here is durable: a reconnecting client sees events again,
	 *  never these frames. */
	readonly frames?: (sessionId: string, push: (frame: WireFrame) => void) => (() => void) | void;
	/** The product's turn preparation; default: `body.input` as given.
	 *  0.42.0: it may instead ANSWER the request itself — write the
	 *  product's own status and body to `res` and return `{ handled: true }`;
	 *  the handler then returns without opening a run, a session, or a 400
	 *  (a gate, a quota, an attachment check, an empty message — the
	 *  product's refusals in the product's shape). */
	readonly prepareInput?: (body: Readonly<Record<string, unknown>>, req: IncomingMessage, sessionId: string, res: ServerResponse) => WireInput | Handled | Promise<WireInput | Handled>;
	readonly projection?: ProjectionOptions;
	/** `: keepalive` comments on an idle stream. Default 15 s; 0 disables. */
	readonly keepaliveMs?: number;
	/** Request-body cap in bytes. Default 1 MiB. */
	readonly bodyLimit?: number;
}

/** What `prepareInput` returns when it answered the request itself. */
export interface Handled {
	readonly handled: true;
}

export interface HttpHandler {
	/** True when the request was an agent route and has been answered. */
	readonly handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
}

/** The store's own rule (`^[A-Za-z0-9._-]+$`), with a length cap. 0.41.2:
 *  the first version also required a leading letter or digit, which the
 *  store never did — a nanoid can start with `_` or `-` (about 1 in 32 do)
 *  and every such session answered 404. */
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const ACTIONS = new Set(["", "state", "events", "replay", "run", "resume", "steer", "abort", "approve", "uncertain"]);

export function createHttpHandler(service: SessionService, options: HttpHandlerOptions): HttpHandler {
	const prefix = (options.prefix ?? "/v1/sessions").replace(/\/+$/, "");
	const keepaliveMs = options.keepaliveMs ?? 15_000;
	const bodyLimit = options.bodyLimit ?? 1024 * 1024;
	const projection = options.projection ?? {};

	const json = (res: ServerResponse, status: number, body: unknown): void => {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(body));
	};
	const fail = (res: ServerResponse, status: number, code: WireErrorCode, message: string, runId?: string): void => {
		const error: WireError = { code, message, ...(runId !== undefined ? { runId } : {}) };
		json(res, status, error);
	};
	/** The service's refusals → the wire's codes. */
	const refuse = (res: ServerResponse, err: unknown): void => {
		if (err instanceof InFlightError) return fail(res, 409, "in_flight", err.message, err.runId);
		if (err instanceof OpenRunError) return fail(res, 409, "open_run", err.message, err.runId);
		if (err instanceof DrainingError) return fail(res, 503, "draining", err.message);
		if (err instanceof NotRunningError) return fail(res, 409, "idle", err.message);
		if (err instanceof RunClosedError) return fail(res, 409, "closed", err.message, err.runId);
		if (err instanceof BadRequest) return fail(res, 400, "bad_request", err.message);
		fail(res, 500, "internal", err instanceof Error ? err.message : String(err));
	};

	const readBody = async (req: IncomingMessage): Promise<Readonly<Record<string, unknown>>> => {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			const buf = chunk as Buffer;
			size += buf.length;
			if (size > bodyLimit) throw new BadRequest(`body exceeds ${bodyLimit} bytes`);
			chunks.push(buf);
		}
		if (chunks.length === 0) return {};
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			throw new BadRequest("body is not JSON");
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new BadRequest("body must be a JSON object");
		return parsed as Record<string, unknown>;
	};

	const inputOf = async (body: Readonly<Record<string, unknown>>, req: IncomingMessage, sessionId: string, res: ServerResponse): Promise<WireInput | Handled> => {
		if (options.prepareInput !== undefined) return options.prepareInput(body, req, sessionId, res);
		const input = body["input"];
		if (typeof input === "string") {
			if (input.trim() === "") throw new BadRequest("input must be a non-empty string");
			return input;
		}
		if (Array.isArray(input) && input.length > 0) return input as WireInput;
		throw new BadRequest("input must be a non-empty string or a non-empty array of content blocks");
	};

	const state = async (sessionId: string): Promise<SessionState> => {
		const events = service.events(sessionId);
		return {
			sessionId,
			running: service.isRunning(sessionId),
			highWater: events.at(-1)?.seq ?? -1,
			openRun: service.openRun(sessionId),
			pendingApprovals: await service.pendingApprovals(sessionId),
			uncertain: (await service.uncertainExecutions(sessionId)).map((u) => ({ executionId: u.executionId, callId: u.callId, name: u.name })),
		};
	};

	/** One durable event → its frames: the wire event (if any) under its seq, then the product's. */
	const framesOf = async (event: Event, sessionId: string): Promise<string> => {
		let out = "";
		const wire = toWireEvent(event, projection);
		if (wire !== null) out += `id: ${wire.seq}\nevent: ${wire.type}\ndata: ${JSON.stringify(wire)}\n\n`;
		// ADR-0057: a 202 steer always has a visible fate — admitted (its
		// user_input is on the stream) or named here, right after the terminal.
		if (event.type === "terminal") {
			const left = service.unadmittedAt(sessionId, event.seq);
			if (left !== null) out += `event: unadmitted\ndata: ${JSON.stringify(left)}\n\n`;
		}
		if (options.augment !== undefined) {
			for (const frame of await options.augment(event, sessionId)) out += `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
		}
		return out;
	};

	/** Open an SSE response and pump the session's events after `after`
	 *  into it until the client leaves or `until` settles. */
	const stream = async (res: ServerResponse, req: IncomingMessage, sessionId: string, after: number, until?: Promise<unknown>): Promise<void> => {
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		});
		res.write(": open\n\n");
		// frames are written in event order even though augment is async:
		// a chain serialises them
		let chain: Promise<void> = Promise.resolve();
		let closed = false;
		const unsubscribe = await service.subscribe(sessionId, after, (event) => {
			chain = chain.then(async () => {
				if (closed) return;
				const text = await framesOf(event, sessionId);
				if (!closed && text !== "") res.write(text);
			});
		});
		// 0.43.0 (#4): the host's frames ride the same chain — ordered with
		// the events, dropped once the stream has ended.
		const push = (frame: WireFrame): void => {
			chain = chain.then(() => {
				if (!closed) res.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
			});
		};
		const stopFrames = options.frames?.(sessionId, push) ?? undefined;
		const keepalive = keepaliveMs > 0 ? setInterval(() => res.write(": keepalive\n\n"), keepaliveMs) : undefined;
		keepalive?.unref();
		const end = (): void => {
			if (closed) return;
			closed = true;
			if (keepalive !== undefined) clearInterval(keepalive);
			stopFrames?.();
			unsubscribe();
		};
		req.on("close", end);
		res.on("close", end);
		if (until !== undefined) {
			await until.catch(() => {});
			await chain; // every frame of the run has been written
			end();
			res.end();
		}
	};

	const afterOf = (req: IncomingMessage, url: URL, body?: Readonly<Record<string, unknown>>): number => {
		const header = req.headers["last-event-id"];
		const fromHeader = typeof header === "string" ? Number(header) : NaN;
		if (Number.isFinite(fromHeader)) return fromHeader;
		const fromBody = body !== undefined && typeof body["after"] === "number" ? (body["after"] as number) : NaN;
		if (Number.isFinite(fromBody)) return fromBody;
		const fromQuery = Number(url.searchParams.get("after") ?? NaN);
		return Number.isFinite(fromQuery) ? fromQuery : -1;
	};

	const handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
		const rest = url.pathname.slice(prefix.length + 1);
		const slash = rest.indexOf("/");
		const rawId = slash === -1 ? rest : rest.slice(0, slash);
		const action = slash === -1 ? "" : rest.slice(slash + 1);
		let sessionId: string;
		try {
			sessionId = decodeURIComponent(rawId);
		} catch {
			fail(res, 400, "bad_request", "malformed session id");
			return true;
		}
		if (!SESSION_ID.test(sessionId) || !ACTIONS.has(action)) {
			fail(res, 404, "not_found", "no such route");
			return true;
		}
		try {
			if (!(await options.authorize(req, sessionId))) {
				fail(res, 403, "forbidden", "this session is not yours");
				return true;
			}
			const method = req.method ?? "GET";
			if (method === "GET" && action === "events") {
				await stream(res, req, sessionId, afterOf(req, url));
				return true;
			}
			if (method === "GET" && (action === "" || action === "state")) {
				json(res, 200, await state(sessionId));
				return true;
			}
			if (method === "GET" && action === "replay") {
				const events = service.events(sessionId).map((e) => toWireEvent(e, projection)).filter((w) => w !== null);
				json(res, 200, { sessionId, events, state: await state(sessionId) });
				return true;
			}
			if (method !== "POST") {
				fail(res, 405, "bad_request", `${method} is not allowed on ${action || "the session"}`);
				return true;
			}
			const body = await readBody(req);
			const wantsStream = url.searchParams.get("stream") === "1";
			if (action === "run" || action === "resume") {
				let handle: { runId: string; done: Promise<void> };
				if (action === "run") {
					const input = await inputOf(body, req, sessionId, res);
					if (isHandled(input)) return true; // the product answered; nothing opened
					const source = body["source"];
					handle = await service.run(sessionId, input, {
						...(source === "user" || source === "suggestion" || source === "tool_result" ? { source: source as WireSource } : {}),
						...(body["resumeFirst"] === true ? { resumeFirst: true } : {}),
					});
				} else {
					handle = await service.resume(sessionId);
				}
				if (wantsStream) await stream(res, req, sessionId, afterOf(req, url, body), handle.done);
				else json(res, 202, { runId: handle.runId });
				return true;
			}
			if (action === "steer") {
				const input = await inputOf(body, req, sessionId, res);
				if (isHandled(input)) return true; // the product answered; nothing steered
				json(res, 202, service.steer(sessionId, input));
				return true;
			}
			if (action === "abort") {
				const outcome = await service.abort(sessionId, body["force"] === true ? { force: true } : {});
				const reply: AbortReply = outcome.kind === "stopped" ? { kind: "stopped", runId: outcome.runId } : outcome;
				json(res, outcome.kind === "parked" ? 409 : 200, reply);
				return true;
			}
			if (action === "approve") {
				const decisionId = body["decisionId"];
				const allow = body["allow"];
				if (typeof decisionId !== "string" || decisionId === "" || typeof allow !== "boolean") throw new BadRequest("decisionId (string) and allow (boolean) are required");
				const reason = body["reason"];
				json(res, 200, await service.approve(sessionId, decisionId, allow, typeof reason === "string" ? reason : undefined));
				return true;
			}
			if (action === "uncertain") {
				const executionId = body["executionId"];
				const resolution = body["resolution"];
				if (typeof executionId !== "string" || executionId === "" || (resolution !== "rerun" && resolution !== "abandoned")) {
					throw new BadRequest('executionId (string) and resolution ("rerun" | "abandoned") are required');
				}
				json(res, 200, await service.resolveUncertain(sessionId, executionId, resolution));
				return true;
			}
			fail(res, 404, "not_found", "no such route");
			return true;
		} catch (err) {
			if (res.headersSent) {
				res.end();
				return true;
			}
			refuse(res, err);
			return true;
		}
	};

	return { handle };
}

function isHandled(v: unknown): v is Handled {
	return typeof v === "object" && v !== null && !Array.isArray(v) && (v as { handled?: unknown }).handled === true;
}

class BadRequest extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BadRequest";
	}
}
