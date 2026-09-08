/**
 * OR-1 — the local double every gate in this package runs against.
 *
 * No test in this package reaches a vendor. The rig is an ordinary
 * `node:http` server on 127.0.0.1: it CAPTURES the request (method, path,
 * headers, raw body bytes) and REPLIES with whatever the test hands it —
 * an SSE script, a non-2xx body, or a stream cut mid-event. The captured
 * body is the raw string, so a byte-for-byte comparison against a frozen
 * fixture is possible (a parsed object would hide key order).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface CapturedRequest {
	readonly method: string;
	/** The request path as sent — the target's shape is part of the contract. */
	readonly path: string;
	readonly headers: Readonly<Record<string, string | string[] | undefined>>;
	/** The RAW body bytes as a UTF-8 string — never re-serialized. */
	readonly body: string;
}

export type Reply = (req: IncomingMessage, res: ServerResponse) => void;

export interface Rig {
	readonly port: number;
	readonly baseUrl: string;
	readonly requests: CapturedRequest[];
	/** Sockets the client still holds open — the cancel gate's evidence. */
	readonly openConnections: () => number;
	/** The reply for the NEXT (and every following) request. */
	reply: Reply;
	close(): Promise<void>;
}

/** An SSE reply: one `data:` frame per event, then the socket closes. */
export function sseReply(events: readonly unknown[]): Reply {
	return (_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
		res.end();
	};
}

/** An SSE reply that is CUT after `n` events — the socket dies mid-stream
 *  with no terminal response event. The destroy is deferred by a tick:
 *  destroying in the same turn kills the socket before the frames flush,
 *  and the client then sees a failed CONNECTION rather than a failed
 *  STREAM — a different case from the one this reply exists to produce. */
export function cutReply(events: readonly unknown[], n: number): Reply {
	return (_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		for (const ev of events.slice(0, n)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
		setTimeout(() => res.destroy(), 20);
	};
}

/** A stream the provider ENDS cleanly after `n` frames without a terminal
 *  response — a truncated turn, not a cut connection. */
export function truncatedReply(events: readonly unknown[], n: number): Reply {
	return (_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		for (const ev of events.slice(0, n)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
		res.end();
	};
}

/** A non-2xx reply with an arbitrary body and headers. */
export function errorReply(status: number, body: string, headers: Readonly<Record<string, string>> = {}): Reply {
	return (_req, res) => {
		res.writeHead(status, { "content-type": "application/json", ...headers });
		res.end(body);
	};
}

/** A reply that never finishes: headers, one comment frame, then silence —
 *  the shape an abort has to escape from. */
export function hangReply(): Reply {
	return (_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(": open\n\n");
	};
}

export async function startRig(initial: Reply = sseReply([])): Promise<Rig> {
	const requests: CapturedRequest[] = [];
	let reply = initial;
	let open = 0;
	const server: Server = createServer((req, res) => {
		let raw = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			requests.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: raw });
			reply(req, res);
		});
	});
	server.on("connection", (socket) => {
		open += 1;
		socket.on("close", () => {
			open -= 1;
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	return {
		port,
		baseUrl: `http://127.0.0.1:${port}`,
		requests,
		openConnections: () => open,
		get reply() {
			return reply;
		},
		set reply(next: Reply) {
			reply = next;
		},
		close: () =>
			new Promise<void>((r) => {
				server.closeAllConnections();
				server.close(() => r());
			}),
	};
}
