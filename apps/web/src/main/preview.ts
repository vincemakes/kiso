import { appendFileSync, createReadStream, realpathSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, extname, join, sep } from "node:path";

/**
 * Page previews. A page the model wrote is untrusted: it must reach neither the host (which can run commands) nor the folder's
 * other files, nor services on this machine. So each preview gets its own server, on a random port under the OTHER loopback name
 * than the page's (the page on 127.0.0.1: the preview on localhost), so the browser never sends it the kiso cookie and it is
 * another origin. Its root is the entry file's own directory. It refuses anything outside it, every dot-file and dot-directory,
 * key-like names and node_modules; GET and HEAD only, no listings. Every response carries a CSP sandbox (an opaque origin that
 * may run scripts) that lets the page load https and its own files and reach no http address. It closes ten minutes after its
 * last request, or when the panel closes it. The panel frames it with sandbox="allow-scripts" only.
 */

const IDLE_MS = 10 * 60_000;
const KEYLIKE = /\.(pem|key|p12|pfx|crt|cer|der|asc|gpg|kdbx|keystore|jks)$|^id_|^credentials|^secrets?(\.|$)/i;
const TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm",
	".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav",
	".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8",
};

interface Preview {
	readonly root: string;
	readonly name: string;
	readonly server: Server;
	port: number;
	timer: NodeJS.Timeout | null;
}

/** Why a path inside the root is refused, or null. */
export function refusedName(rel: string): string | null {
	const parts = rel.split("/").filter((p) => p !== "");
	if (parts.some((p) => p.startsWith("."))) return "dot-file";
	if (parts.includes("node_modules")) return "node_modules";
	if (KEYLIKE.test(parts.at(-1) ?? "")) return "key-like name";
	return null;
}

export class Previews {
	readonly #open = new Map<string, Preview>();
	/** a file each request is written to, with its answer (the proofs read it) */
	readonly #log: string | undefined;

	constructor(log?: string) {
		this.#log = log;
	}

	/** The address of `entry` (a file's real path) on its directory's preview server, started if there is none. `ancestor`: the page's origin, the one that may frame it. */
	async open(entry: string, pageHost: string, ancestor: string): Promise<string> {
		const name = pageHost.startsWith("localhost") ? "127.0.0.1" : "localhost";
		const root = dirname(entry);
		const key = `${name} ${ancestor} ${root}`;
		const preview = this.#open.get(key) ?? (await this.#start(key, root, name, ancestor));
		this.#touch(key, preview);
		return `http://${name}:${preview.port}/${encodeURIComponent(basename(entry))}`;
	}

	/** Close the preview that serves `url` (its panel closed). */
	close(url: string): void {
		for (const [key, p] of this.#open) if (url.startsWith(`http://${p.name}:${p.port}/`)) this.#stop(key, p);
	}

	closeAll(): void {
		for (const [key, p] of this.#open) this.#stop(key, p);
	}

	#stop(key: string, p: Preview): void {
		if (p.timer !== null) clearTimeout(p.timer);
		this.#open.delete(key);
		p.server.closeAllConnections();
		p.server.close();
	}

	#touch(key: string, p: Preview): void {
		if (p.timer !== null) clearTimeout(p.timer);
		p.timer = setTimeout(() => this.#stop(key, p), IDLE_MS);
		p.timer.unref();
	}

	async #start(key: string, root: string, name: string, ancestor: string): Promise<Preview> {
		const headers = {
			"content-security-policy": `sandbox allow-scripts; default-src 'self' 'unsafe-inline' https: data: blob:; connect-src 'self' https:; frame-ancestors ${ancestor}`,
			"x-content-type-options": "nosniff",
			"access-control-allow-origin": "*",
			"cache-control": "no-store",
			"referrer-policy": "no-referrer",
		};
		const server = createServer((req, res) => {
			this.#touch(key, preview);
			const end = (status: number, why: string): void => {
				if (this.#log !== undefined) appendFileSync(this.#log, `${req.method} ${req.url} ${status} ${why}\n`);
				res.writeHead(status, headers);
				res.end();
			};
			if (req.headers.host !== `${name}:${preview.port}`) return end(403, "unknown Host");
			if (req.method !== "GET" && req.method !== "HEAD") return end(405, "GET and HEAD only");
			let rel: string;
			try {
				rel = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
			} catch {
				return end(400, "bad path");
			}
			if (rel.split("/").every((p) => p === "")) return end(404, "no listing");
			const why = refusedName(rel);
			if (why !== null) return end(403, why);
			let real: string;
			try {
				real = realpathSync(join(root, rel));
			} catch {
				return end(404, "no such file");
			}
			// a link may lead out of the root, or into a dot-directory inside it
			if (!real.startsWith(root + sep)) return end(403, "outside the root");
			const inner = refusedName(real.slice(root.length + 1));
			if (inner !== null) return end(403, inner);
			const stat = statSync(real);
			if (!stat.isFile()) return end(404, "no listing");
			const type = TYPES[extname(real).toLowerCase()] ?? "application/octet-stream";
			// a range, for media (Safari plays video only by ranges)
			const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
			const first = range === null ? 0 : range[1] === "" ? Math.max(0, stat.size - Number(range[2])) : Number(range[1]);
			const last = range === null || range[2] === "" || range[1] === "" ? stat.size - 1 : Math.min(stat.size - 1, Number(range[2]));
			if (this.#log !== undefined) appendFileSync(this.#log, `${req.method} ${req.url} ${range === null ? 200 : 206} served\n`);
			res.writeHead(range === null ? 200 : 206, { ...headers, "content-type": type, "content-length": String(Math.max(0, last - first + 1)), "accept-ranges": "bytes", ...(range === null ? {} : { "content-range": `bytes ${first}-${last}/${stat.size}` }) });
			if (req.method === "HEAD" || last < first) return void res.end();
			createReadStream(real, { start: first, end: last }).pipe(res);
		});
		const preview: Preview = { root, name, server, port: 0, timer: null };
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, name, resolve);
		});
		preview.port = (server.address() as AddressInfo).port;
		this.#open.set(key, preview);
		return preview;
	}
}
