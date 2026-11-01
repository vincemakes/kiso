import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IncomingMessage } from "node:http";

/**
 * The page's sign-in. The command that starts the host opens the browser on `#c=<code>`: a one-time connect code that lives two
 * minutes. The page trades it once (`POST /auth/connect`) for a session cookie, `HttpOnly` and `SameSite=Strict`, named after the
 * port, and strips the fragment: the page never holds a long-lived secret, and a cookie (unlike page storage) is what Safari copies
 * into a web app added to the Dock. The host keeps the sessions in `$KISO_HOME/web.json` (mode 0600), as SHA-256 hashes only, and
 * reads the file again when it changes, so `kiso-web --revoke-sessions` reaches a host that is running. A cookie on 127.0.0.1 is
 * sent to every port of that host, so the cookie is never the whole guard: the Host and Origin checks stay on every request.
 */

const CODE_TTL_MS = 120_000;
/** a year: the cookie outlives a browser restart and a Dock launch (browsers cap it near 400 days anyway) */
const COOKIE_AGE_S = 365 * 86_400;
const MAX_SESSIONS = 50;

interface WebFile {
	readonly sessions?: readonly { readonly hash: string; readonly createdAt: number }[];
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export const cookieName = (port: number): string => `kiso_web_${port}`;
export const webFile = (home: string): string => join(home, "web.json");

function readWeb(file: string): WebFile {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as WebFile;
	} catch {
		return {};
	}
}

function writeWeb(file: string, data: WebFile): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, "\t")}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, file);
}

/** Forget every session: each page signed in before must be opened again from the command. Returns how many were forgotten. */
export function revokeSessions(home: string): number {
	const file = webFile(home);
	const count = readWeb(file).sessions?.length ?? 0;
	writeWeb(file, { ...readWeb(file), sessions: [] });
	return count;
}

export class Auth {
	readonly #file: string;
	readonly #cookie: string;
	readonly #codes = new Map<string, number>();
	#hashes = new Set<string>();
	#stamp = "";

	constructor(home: string, port: number) {
		this.#file = webFile(home);
		this.#cookie = cookieName(port);
	}

	/** A fresh one-time code for the browser's address. */
	code(): string {
		const now = Date.now();
		for (const [c, at] of this.#codes) if (now - at > CODE_TTL_MS) this.#codes.delete(c);
		const code = randomBytes(24).toString("base64url");
		this.#codes.set(sha256(code), now);
		return code;
	}

	/** Trade a code for a new session: the Set-Cookie value, or null (unknown, used or expired). */
	connect(code: unknown): string | null {
		if (typeof code !== "string" || code.length > 128) return null;
		const key = sha256(code);
		const at = this.#codes.get(key);
		this.#codes.delete(key);
		if (at === undefined || Date.now() - at > CODE_TTL_MS) return null;
		const session = randomBytes(32).toString("base64url");
		const kept = (readWeb(this.#file).sessions ?? []).slice(-(MAX_SESSIONS - 1));
		writeWeb(this.#file, { ...readWeb(this.#file), sessions: [...kept, { hash: sha256(session), createdAt: Date.now() }] });
		return `${this.#cookie}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_AGE_S}`;
	}

	/** Whether the request carries a session cookie the host still keeps. */
	signedIn(req: IncomingMessage): boolean {
		const given = (req.headers.cookie ?? "")
			.split(";")
			.map((part) => part.trim())
			.find((part) => part.startsWith(`${this.#cookie}=`))
			?.slice(this.#cookie.length + 1);
		if (given === undefined || given === "") return false;
		this.#reload();
		const hash = Buffer.from(sha256(given));
		for (const known of this.#hashes) if (timingSafeEqual(Buffer.from(known), hash)) return true;
		return false;
	}

	/** The cookie that ends this browser's session (a sign-out). */
	cleared(): string {
		return `${this.#cookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
	}

	#reload(): void {
		let stamp = "none";
		try {
			const s = statSync(this.#file);
			stamp = `${s.mtimeMs}:${s.size}`;
		} catch {
			// no file: no session
		}
		if (stamp === this.#stamp) return;
		this.#stamp = stamp;
		this.#hashes = new Set((readWeb(this.#file).sessions ?? []).map((s) => s.hash));
	}
}
