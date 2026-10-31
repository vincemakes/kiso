import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { canonicalPath, claimProjectDir, projectDirFor, sessionFolders } from "@vincemakes/kiso-code/config";
import { kisoHome, type SessionStore } from "@vincemakes/kiso-runtime";
import type { SessionService } from "@vincemakes/kiso-server";
import type { Settings } from "./settings.js";
import { Auth } from "./auth.js";
import { ApprovalWatch, type Notice, type Presence } from "./approvals.js";
import { deskApi, type DeskContext } from "./desk-api.js";
import { History } from "./history.js";
import { createSpace, type Space } from "./space.js";
import type { TaskHub } from "./tasks.js";
import type { WorkState } from "../shared/history.js";

/**
 * The loopback host: the hosted-session service behind HTTP + SSE on
 * 127.0.0.1, Host and Origin checks on every request, and two ways in: the
 * page's session cookie (auth.ts) and, for scripts on this machine, a
 * per-launch bearer token the page never sees; plus the page that prints the stream. The transport (routes, framing,
 * Last-Event-ID, keepalive, status codes) is packages/server/http.ts; what
 * this file adds is the three things that file leaves to the host — the
 * listener, the guard, and the product's frames (space.ts) — and the
 * Works of every project folder: the folder in use is served at `/v1/...`,
 * any other folder at `/w/<key>/v1/...`, and `/desk/history` lists them all.
 */

export interface HostOptions {
	/** The kiso home: `projects/<enc>/` under it holds the sessions, as for the terminal (default: `kisoHome()`). */
	readonly home?: string;
	/** The folder a new task starts in. */
	readonly workspace: string;
	/** The model, the sign-in, the effort and the tier: read when a Work opens (settings.ts). */
	readonly settings: Settings;
	/** Also told of each notice (an approval waits, a run ended, while the person is elsewhere); the page reads them from `/desk/notices`. */
	readonly notify?: (notice: Notice) => void;
	/** 0: the system picks (the proofs); the command passes its fixed port. */
	readonly port?: number;
	readonly token?: string;
	/** Project thinking text on the wire (default true: the page shows it). */
	readonly exposeThinking?: boolean;
	/** "default": the server's sanitizer; "web": ours. */
	readonly sanitizer?: "default" | "web";
	readonly keepaliveMs?: number;
	readonly toolLimits?: { readonly minForegroundMs?: number; readonly maxForegroundMs?: number };
}

export interface Host {
	readonly origin: string;
	readonly port: number;
	readonly token: string;
	/** A one-time connect code for the browser's address (`#c=<code>`), good for two minutes. */
	readonly connectCode: () => string;
	/** The service, store and tasks of the folder in use. */
	readonly service: SessionService;
	readonly store: SessionStore;
	readonly tasks: TaskHub;
	/** The folder in use: its key in the routes and its path. */
	readonly current: { readonly key: string; readonly workspace: string };
	/** Orderly exit: drain, stop listening, close the stores. */
	readonly close: (graceMs?: number) => Promise<void>;
}

export async function startHost(options: HostOptions): Promise<Host> {
	const token = options.token ?? randomBytes(32).toString("hex");
	const home = options.home ?? kisoHome();
	const spaces = new Map<string, Space>();
	const spaceOptions = (key: string, workspace: string, dir: string, prefix: string): Parameters<typeof createSpace>[0] => ({
		key,
		workspace,
		dir,
		prefix,
		model: (ctx) => options.settings.model(ctx),
		tierOf: (sessionId) => options.settings.tierOf(sessionId),
		checkRunners: () => options.settings.checks(),
		secretEnvNames: options.settings.secretEnvNames(),
		exposeThinking: options.exposeThinking ?? true,
		sanitizer: options.sanitizer ?? "web",
		...(options.keepaliveMs !== undefined ? { keepaliveMs: options.keepaliveMs } : {}),
		...(options.toolLimits !== undefined ? { toolLimits: options.toolLimits } : {}),
	});

	// the folder in use: its directory is claimed (named after its path) the way the terminal claims it
	const workspace = canonicalPath(options.workspace);
	const currentDir = projectDirFor(home, workspace);
	claimProjectDir(currentDir, workspace);
	const current = createSpace(spaceOptions(basename(currentDir), workspace, currentDir, "/v1/sessions"));
	spaces.set(current.key, current);
	/** Another folder's space, made on first use; only a folder the listing names (a key is never a path). */
	const spaceFor = (key: string): Space | null => {
		const held = spaces.get(key);
		if (held !== undefined) return held;
		const folder = sessionFolders(home).find((f) => f.kind === "project" && f.workspace !== null && basename(f.dir) === key);
		if (folder === undefined || folder.workspace === null) return null;
		const space = createSpace(spaceOptions(key, folder.workspace, folder.dir, `/w/${key}/v1/sessions`));
		spaces.set(key, space);
		return space;
	};

	const history = new History(home, async (key, sessionId): Promise<WorkState> => {
		const space = spaces.get(key);
		if (space === undefined || !space.service.isRunning(sessionId)) return "idle";
		return (await space.service.pendingApprovals(sessionId)).length > 0 ? "waiting" : "running";
	});

	const rendererDir = fileURLToPath(new URL("../../out/renderer/", import.meta.url));
	const tokenBytes = Buffer.from(token);
	let auth: Auth | undefined;

	let presence: Presence | null = null;
	const watch = new ApprovalWatch(() => spaces.values(), options.notify, () => presence);
	watch.start();
	const desk: DeskContext = { home, settings: options.settings, current, history, spaceFor, setPresence: (p) => (presence = p), notices: (seq) => watch.since(seq) };

	let origins: ReadonlySet<string> = new Set();
	let hosts: ReadonlySet<string> = new Set();

	const refuse = (res: ServerResponse, status: number, message: string): void => {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ code: "forbidden", message }));
	};
	const answer = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
		res.end(JSON.stringify(body));
	};
	/** The page's cookie, sent from the page itself: a request another page made (another port of 127.0.0.1 is the same site) says so in Sec-Fetch-Site. */
	const cookieOk = (req: IncomingMessage): boolean => {
		const site = req.headers["sec-fetch-site"];
		if (site !== undefined && site !== "same-origin" && site !== "none") return false;
		return auth?.signedIn(req) ?? false;
	};
	/** The sign-in doors: status (open; it also tells another `kiso-web` that this port is ours), connect (the page trades its code), code (scripts, by token). */
	const authRoute = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
		if (path === "/auth/status" && req.method === "GET") return answer(res, 200, { app: "kiso-web", signedIn: cookieOk(req) });
		if (path === "/auth/connect" && req.method === "POST") {
			// only our own page may trade a code: a browser always names the origin of a POST
			if (!origins.has(req.headers.origin ?? "")) return refuse(res, 403, "Origin not allowed");
			let text = "";
			for await (const chunk of req) if ((text += chunk).length > 1024) return refuse(res, 413, "too large");
			let code: unknown;
			try {
				code = (JSON.parse(text) as { code?: unknown }).code;
			} catch {
				code = undefined;
			}
			const cookie = auth?.connect(code) ?? null;
			return cookie === null ? refuse(res, 401, "the connect code is unknown, used or expired: run kiso web") : answer(res, 200, { ok: true }, { "set-cookie": cookie });
		}
		if (path === "/auth/code" && req.method === "POST") return bearerOk(req) ? answer(res, 200, { code: auth!.code() }) : refuse(res, 401, "missing or wrong token");
		res.writeHead(404);
		res.end();
	};
	const bearerOk = (req: IncomingMessage): boolean => {
		const header = req.headers.authorization ?? "";
		if (!header.startsWith("Bearer ")) return false;
		const given = Buffer.from(header.slice(7));
		return given.length === tokenBytes.length && timingSafeEqual(given, tokenBytes);
	};
	const TYPES: Readonly<Record<string, string>> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
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
				"content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; frame-src http://localhost:* http://127.0.0.1:*; base-uri 'none'; form-action 'none'",
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
			const origin = req.headers.origin;
			if (origin !== undefined && !origins.has(origin)) return refuse(res, 403, "Origin not allowed");
			if (url.pathname.startsWith("/auth/")) return authRoute(req, res, url.pathname);
			const other = /^\/w\/([A-Za-z0-9._-]+)\/v1\//.exec(url.pathname);
			if (!url.pathname.startsWith("/v1/") && other === null && !url.pathname.startsWith("/desk/")) {
				if (req.method !== "GET") {
					res.writeHead(405);
					return void res.end();
				}
				return serveStatic(res, url.pathname);
			}
			if (!bearerOk(req) && !cookieOk(req)) return refuse(res, 401, "not signed in: run kiso web");
			if (url.pathname.startsWith("/desk/")) {
				const answer = await deskApi(desk, req, url);
				res.writeHead(answer.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
				return void res.end(JSON.stringify(answer.body));
			}
			const space = other === null ? current : spaceFor(other[1]!);
			if (space === null || !(await space.handler.handle(req, res))) {
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
	auth = new Auth(home, port);

	let closed = false;
	const close = async (graceMs = 5_000): Promise<void> => {
		if (closed) return;
		closed = true;
		// the order that keeps every run resumable (packages/server README):
		// drain, stop the listener, close the stores
		await Promise.all([...spaces.values()].map((space) => space.drain(graceMs)));
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		watch.stop();
		history.close();
		for (const space of spaces.values()) await space.close();
	};

	return { origin: `http://127.0.0.1:${port}`, port, token, connectCode: () => auth!.code(), service: current.service, store: current.store, tasks: current.tasks, current: { key: current.key, workspace }, close };
}
