import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { SessionStore } from "@vincemakes/kiso-runtime";
import { createSessionService, type SessionService } from "@vincemakes/kiso-server";
import { toWireEvent } from "@vincemakes/kiso-server";
import { createHttpHandler, type HttpHandlerOptions } from "@vincemakes/kiso-server/http";
import type { Event } from "@vincemakes/kiso-core";
import type { WireFrame } from "@vincemakes/kiso-protocol";
import { createDesktopAgent, type ModelChoice, type PermissionMode } from "./agent.js";
import { createTaskHub, rowsOf, type TaskHub } from "./tasks.js";
import { runTotals, usageFrameAt } from "./usage.js";
import { desktopSanitize } from "./sanitize.js";
import { TimeIndex } from "./times.js";
import type { AtFrame, TasksFrame, ToolOutputFrame } from "../shared/frames.js";

/**
 * The loopback host: the hosted-session service behind HTTP + SSE on
 * 127.0.0.1, a random port, a per-launch bearer token and an Origin check,
 * plus the page that prints the stream. The transport (routes, framing,
 * Last-Event-ID, keepalive, status codes) is packages/server/http.ts; what
 * this file adds is the three things that file leaves to the host — the
 * listener, the guard, and the product's frames.
 */

export interface HostOptions {
	/** Holds `sessions/` (the store). */
	readonly dataDir: string;
	readonly workspace: string;
	readonly model: ModelChoice;
	/** The permission tier (default: `default`, which asks before writes and commands). */
	readonly mode?: PermissionMode;
	readonly secretEnvNames?: readonly string[];
	/** Default 0: the system picks. */
	readonly port?: number;
	readonly token?: string;
	/** Project thinking text on the wire (default true: the desktop shows it). */
	readonly exposeThinking?: boolean;
	/** "default": the server's sanitizer; "desktop": ours. */
	readonly sanitizer?: "default" | "desktop";
	readonly keepaliveMs?: number;
	readonly toolLimits?: { readonly minForegroundMs?: number; readonly maxForegroundMs?: number };
}

export interface Host {
	readonly origin: string;
	readonly port: number;
	readonly token: string;
	readonly service: SessionService;
	readonly store: SessionStore;
	readonly tasks: TaskHub;
	/** Orderly exit: drain, stop listening, close the store. */
	readonly close: (graceMs?: number) => Promise<void>;
}

const HEAD_LINES = 12;

export async function startHost(options: HostOptions): Promise<Host> {
	const token = options.token ?? randomBytes(32).toString("hex");
	const sessionsDir = join(options.dataDir, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	const store = new SessionStore(sessionsDir);
	const tasks = createTaskHub(sessionsDir);
	const route = options.model.kind === "adapter" ? options.model.route : options.model.provider;

	const service = createSessionService({
		store,
		open: async () =>
			createDesktopAgent({
				store,
				workspace: options.workspace,
				model: options.model,
				tasks,
				mode: options.mode ?? "default",
				...(options.secretEnvNames !== undefined ? { secretEnvNames: options.secretEnvNames } : {}),
				...(options.toolLimits !== undefined ? { toolLimits: options.toolLimits } : {}),
				onSession: (sessionId, session) => {
					// the model hears how a task ended; nothing wakes an idle session
					session.useTasks(tasks.managerFor(sessionId), { wake: false });
				},
			}),
	});

	const times = new TimeIndex(store);
	const DELTAS = new Set<Event["type"]>(["thinking", "text_delta"]);
	const augment: NonNullable<HttpHandlerOptions["augment"]> = (event: Event, sessionId: string): readonly WireFrame[] => {
		const frames: WireFrame[] = [];
		// when it happened: for every wire event but the two delta types, which are too many
		if (!DELTAS.has(event.type) && toWireEvent(event) !== null) {
			const at: AtFrame = { seq: event.seq, ts: times.at(sessionId, event.seq) };
			frames.push({ event: "at", data: at });
		}
		frames.push(...derived(event, sessionId));
		return frames;
	};
	const derived = (event: Event, sessionId: string): readonly WireFrame[] => {
		if (event.type === "usage") {
			const frame = usageFrameAt(service.events(sessionId), event.seq, route);
			return frame === null ? [] : [{ event: "usage", data: frame }];
		}
		if (event.type === "terminal") {
			const totals = runTotals(service.events(sessionId), event.seq, route);
			return totals === null ? [] : [{ event: "run_usage", data: { seq: event.seq, ...totals } }];
		}
		if (event.type === "tool_result") {
			const text = typeof event.content === "string" ? event.content : event.content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
			const lines = text.split("\n");
			const frame: ToolOutputFrame = {
				seq: event.seq,
				callId: event.callId,
				isError: event.isError,
				head: lines.slice(0, HEAD_LINES),
				lines: lines.length,
				bytes: Buffer.byteLength(text),
				truncated: lines.length > HEAD_LINES,
			};
			return [{ event: "tool_output", data: frame }];
		}
		return [];
	};

	// The tasks frame: not tied to any event (a command can end while nothing
	// else happens), so it is the host's own source, polled while a stream is open.
	const frames: NonNullable<HttpHandlerOptions["frames"]> = (sessionId, push) => {
		let last = "";
		const tick = (): void => {
			try {
				const rows = rowsOf(tasks.managerFor(sessionId));
				// elapsed time of a running task changes every tick; the state does not
				const key = JSON.stringify(rows.map((r) => [r.id, r.label]));
				const running = rows.some((r) => r.endedAt === null);
				if (key !== last || running) {
					last = key;
					const frame: TasksFrame = { at: Date.now(), tasks: rows };
					push({ event: "tasks", data: frame });
				}
			} catch {
				// a corrupt journal is the terminal's to report; the stream goes on
			}
		};
		tick();
		const timer = setInterval(tick, 1_000);
		timer.unref();
		return () => clearInterval(timer);
	};

	const handler = createHttpHandler(service, {
		// the guard below has already run: bearer token, Host and Origin
		authorize: () => true,
		augment,
		frames,
		projection: { exposeThinking: options.exposeThinking ?? true, ...(options.sanitizer === "default" ? {} : { sanitize: desktopSanitize }) },
		...(options.keepaliveMs !== undefined ? { keepaliveMs: options.keepaliveMs } : {}),
	});

	const rendererDir = fileURLToPath(new URL("../../out/renderer/", import.meta.url));
	const tokenBytes = Buffer.from(token);

	let origins: ReadonlySet<string> = new Set();
	let hosts: ReadonlySet<string> = new Set();

	const refuse = (res: ServerResponse, status: number, message: string): void => {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ code: "forbidden", message }));
	};
	const bearerOk = (req: IncomingMessage): boolean => {
		const header = req.headers.authorization ?? "";
		if (!header.startsWith("Bearer ")) return false;
		const given = Buffer.from(header.slice(7));
		return given.length === tokenBytes.length && timingSafeEqual(given, tokenBytes);
	};
	const TYPES: Readonly<Record<string, string>> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
	/** A file of the bundled renderer, by URL path; nothing outside its folder is served. */
	const serveStatic = (res: ServerResponse, pathname: string): void => {
		const full = resolve(rendererDir, pathname === "/" ? "index.html" : `.${pathname}`);
		const type = TYPES[extname(full)];
		try {
			if (type === undefined || !full.startsWith(rendererDir)) throw new Error("not served");
			const body = readFileSync(full);
			// the page runs its own bundle and talks to its own origin, nothing else
			res.writeHead(200, {
				"content-type": type,
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
				"content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
			});
			res.end(body);
		} catch {
			res.writeHead(404);
			res.end();
		}
	};

	const server: Server = createServer((req, res) => {
		void (async () => {
			// DNS rebinding: a name that resolves to 127.0.0.1 but is not ours
			if (!hosts.has(req.headers.host ?? "")) return refuse(res, 403, "unknown Host");
			const url = new URL(req.url ?? "/", "http://localhost");
			if (!url.pathname.startsWith("/v1/")) {
				if (req.method !== "GET") {
					res.writeHead(405);
					return void res.end();
				}
				return serveStatic(res, url.pathname);
			}
			const origin = req.headers.origin;
			if (origin !== undefined && !origins.has(origin)) return refuse(res, 403, "Origin not allowed");
			if (!bearerOk(req)) return refuse(res, 401, "missing or wrong token");
			if (!(await handler.handle(req, res))) {
				res.writeHead(404);
				res.end();
			}
		})().catch(() => {
			if (!res.headersSent) res.writeHead(500);
			res.end();
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, "127.0.0.1", resolve);
	});
	const port = (server.address() as AddressInfo).port;
	origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
	hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

	let closed = false;
	const close = async (graceMs = 5_000): Promise<void> => {
		if (closed) return;
		closed = true;
		// the order that keeps every run resumable (packages/server README):
		// drain, stop the listener, close the store
		await service.drain(graceMs);
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await tasks.close();
		store.closeAll();
	};

	return { origin: `http://127.0.0.1:${port}`, port, token, service, store, tasks, close };
}
