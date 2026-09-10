/**
 * The credential store — sign-in's foundation (the sign-in plan, 2026-09-08).
 *
 * `~/.kiso/auth.json` holds one credential per provider: an API key, or an
 * OAuth token set (the flows arrive in the next step; the shape is fixed now
 * so a stored OAuth credential is recognized, never misread as a key). The
 * file is written atomically (tmp + rename) with mode 0600 on creation; the
 * ONE write path is `modifyAuthFile`, serialized across processes by a
 * directory lock beside the file — no dependency, and a stale lock (an
 * earlier process that died) is reclaimed by age.
 *
 * The resolve rule (the reference implementation's, kept as design): a
 * stored credential OWNS its provider. When one exists it is used; when it is
 * unusable (an OAuth token where the adapter needs a key; a malformed file)
 * the failure is named and there is NO silent fall back to an env var — "which
 * key paid for this" stays answerable. Only when nothing is stored does the
 * profile's env var apply, as before.
 *
 * Keys never appear in stdout, in the session log, or in an error message —
 * `maskSecret` is the only rendering.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { kisoHome } from "../state.js";

export type Credential =
	| { readonly type: "api-key"; readonly key: string; readonly savedAt: number }
	| {
			readonly type: "oauth";
			readonly access: string;
			readonly refresh: string;
			/** epoch milliseconds */
			readonly expires: number;
			readonly accountId?: string;
			readonly savedAt: number;
	  };

export interface AuthFile {
	readonly version: 1;
	readonly credentials: Readonly<Record<string, Credential>>;
}

export class AuthError extends Error {}

/** The providers a credential can be stored for (the runtime's built-in
 *  manifests; `custom` endpoints stay on env vars — a key for an unknown
 *  origin has no identity to own). */
export const KNOWN_PROVIDERS: readonly string[] = ["anthropic", "openai", "deepseek", "zai", "chatgpt"];
/** The providers whose sign-in is an OAuth flow rather than a key. */
export const OAUTH_PROVIDERS: readonly string[] = ["chatgpt"];

// Mirrors the runtime's known-origin table (packages/runtime/src/provider/
// manifest.ts, not on the SDK surface): a compat profile whose baseUrl origin
// is a built-in endpoint resolves to that provider's identity.
const ORIGIN_TO_PROVIDER: Readonly<Record<string, string>> = {
	"https://api.openai.com": "openai",
	"https://api.deepseek.com": "deepseek",
	"https://api.z.ai": "zai",
	"https://open.bigmodel.cn": "zai",
};

/** The ChatGPT backend's origin — the one that means the SUBSCRIPTION
 *  identity rather than OpenAI's. Mirrors the runtime's CHATGPT_ORIGIN.
 *  Absent from ORIGIN_TO_PROVIDER on purpose: that table resolves
 *  openai-CHAT profiles, and the subscription backend serves only the
 *  Responses dialect. */
const CHATGPT_ORIGIN = "https://chatgpt.com";

/** R1 — the vendors' OWN origins. A profile whose baseUrl points anywhere
 *  else authenticates with `apiKeyEnv` and nothing else, however familiar
 *  the dialect it speaks. */
const ANTHROPIC_ORIGIN = "https://api.anthropic.com";
const OPENAI_ORIGIN = "https://api.openai.com";

/** The provider identity a profile's credential is stored under, or null
 *  for an origin nobody recognizes (custom: env var only). */
export function providerIdOf(kind: string, baseUrl?: string): string | null {
	// R1 — A STORED CREDENTIAL NEVER LEAVES THE VENDOR'S OWN ORIGIN.
	//
	// This returned `anthropic` for every anthropic-kind profile and
	// `openai` for every non-ChatGPT Responses profile, whatever the
	// baseUrl said. `authForProfile` takes the stored credential BEFORE
	// the profile's `apiKeyEnv`, so a profile pointing at a proxy — with
	// an explicit key named for that proxy — sent THE VENDOR'S STORED KEY
	// to the proxy and never read the env var at all. Reproduced against a
	// local capture in the 2026-09-10 external review.
	//
	// OR-1's reasoning is superseded for this question, and the sentence it
	// turned on is where it went wrong: "a Responses endpoint that is
	// neither is still OpenAI's API shape behind a proxy, and its
	// credential is OpenAI's". The DIALECT is OpenAI's; the CREDENTIAL is
	// not. Who speaks the protocol and who should be paid to answer are
	// different questions, and only the second one decides where a secret
	// may go.
	//
	// The compat kind was already right — an unrecognized origin resolves
	// to null and the env var pays — so this makes the other two agree with
	// the one that had the rule.
	const origin = originOf(baseUrl);
	if (kind === "anthropic") {
		if (baseUrl === undefined) return "anthropic"; // the vendor's own default endpoint
		return origin === ANTHROPIC_ORIGIN ? "anthropic" : null;
	}
	if (kind === "openai-responses") {
		if (baseUrl === undefined) return "openai"; // the vendor's own default endpoint
		if (origin === CHATGPT_ORIGIN) return "chatgpt";
		return origin === OPENAI_ORIGIN ? "openai" : null;
	}
	if (kind !== "openai-compat") return null;
	if (baseUrl === undefined) return "openai";
	return origin === null ? null : (ORIGIN_TO_PROVIDER[origin] ?? null);
}

function originOf(baseUrl: string | undefined): string | null {
	if (baseUrl === undefined) return null;
	try {
		return new URL(baseUrl).origin;
	} catch {
		return null;
	}
}

export function authPath(): string {
	return join(kisoHome(), "auth.json");
}

const EMPTY: AuthFile = { version: 1, credentials: {} };

export function readAuthFile(path: string = authPath()): AuthFile {
	if (!existsSync(path)) return EMPTY;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new AuthError(`${path} is not valid JSON (${(err as Error).message}) — fix or remove it; kiso never guesses at credentials`);
	}
	if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 1 || typeof (parsed as { credentials?: unknown }).credentials !== "object") {
		throw new AuthError(`${path} has an unknown shape (expected version 1) — fix or remove it`);
	}
	return parsed as AuthFile;
}

export function getCredential(providerId: string, path: string = authPath()): Credential | undefined {
	return readAuthFile(path).credentials[providerId];
}

/** The lock: a directory beside the file. mkdir is atomic on every platform
 *  Node runs on; a lock older than STALE_MS belongs to a process that died
 *  and is reclaimed. Waits up to WAIT_MS, then refuses by name. */
const STALE_MS = 30_000;
const WAIT_MS = 10_000;
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function withLock<T>(path: string, fn: () => T): T {
	const lock = `${path}.lock`;
	const deadline = Date.now() + WAIT_MS;
	for (;;) {
		try {
			mkdirSync(lock);
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			let age = 0;
			try {
				age = Date.now() - statSync(lock).mtimeMs;
			} catch {
				continue; // it vanished between the mkdir and the stat — try again
			}
			if (age > STALE_MS) {
				rmSync(lock, { recursive: true, force: true });
				continue;
			}
			if (Date.now() > deadline) throw new AuthError(`${path} is locked by another kiso process (${lock}); try again, or remove the lock if no kiso is running`);
			sleepSync(25);
		}
	}
	try {
		return fn();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

/** The one write path: lock, read, transform, write atomically (mode 0600
 *  on creation; the home directory 0700 on creation). Returns what was written. */
export function modifyAuthFile(fn: (file: AuthFile) => AuthFile, path: string = authPath()): AuthFile {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	return withLock(path, () => {
		const next = fn(readAuthFile(path));
		const tmp = `${path}.tmp-${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, path);
		return next;
	});
}

export function setCredential(providerId: string, credential: Credential, path: string = authPath()): void {
	modifyAuthFile((file) => ({ version: 1, credentials: { ...file.credentials, [providerId]: credential } }), path);
}

/** Removes the credential; false when there was none. */
export function deleteCredential(providerId: string, path: string = authPath()): boolean {
	let had = false;
	modifyAuthFile((file) => {
		had = providerId in file.credentials;
		const { [providerId]: _gone, ...rest } = file.credentials;
		return { version: 1, credentials: rest };
	}, path);
	return had;
}

/** The only rendering of a secret: its length class and last four characters. */
export function maskSecret(secret: string): string {
	if (secret.length <= 4) return "••••";
	return `••••${secret.slice(-4)}`;
}
