/**
 * Merge round B — the config surface (schema v1).
 *
 * Two files: the user config `~/.kiso/config.json` and the project config
 * `<cwd>/.kiso/config.json` (an artifact of the E3 trust package — a
 * trusted project's config applies, an untrusted one is never even read).
 * Precedence: flags > env > project config > user config > defaults.
 *
 * Schema v1:
 *   model?: string   — a profile NAME (models.<name>) or "provider/model"
 *                      direct write (provider: "openai-compat" |
 *                      "anthropic" | "openai-responses")
 *   models?: { [name]: { kind: "openai-compat"|"anthropic"|"openai-responses",
 *                        baseUrl?: string, model: string, apiKeyEnv: string,
 *                        upstream?: string } }   — upstream: never where requests go
 *   mode?: "default"|"accept-edits"|"plan"|"full-access" — and every older
 *                    spelling: "manual", "bypass" (full-access's old name),
 *                    "dontAsk" (default with the don't-ask switch on)
 *   dontAsk?: boolean           — the don't-ask switch (mode.ts)
 *   contextWindow?: number      — tokens
 *   autoCompact?: { thresholdRatio: number }   — 0<r<1; default off
 *   projectTrust?: "ask" | "never"             — no "always" (the ruling)
 *
 * Credential discipline (HARD): a config NEVER stores a key — only the
 * apiKeyEnv NAME it reads from the environment at use time. A profile
 * whose apiKeyEnv is unset is UNAVAILABLE (listed as such; switching to
 * it is refused loudly) — never a crash.
 *
 * Failure discipline: a broken JSON file fails LOUDLY (file + reason,
 * non-zero exit) — a silently ignored config would mislead. A known key
 * with an invalid value is likewise loud; unknown top-level keys are
 * ignored (forward compatibility).
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { kisoHome } from "./state.js";
import { MODE_VALUES, parseMode, type Mode } from "./mode.js";
import { AuthError, effectiveBaseUrl, endpointCredentialId, getCredential, providerIdOf } from "./auth/credentials.js";
import { BUILTIN_MANIFESTS } from "@vincemakes/kiso-runtime/internal";

/** OR-1: `openai-responses` is a DIALECT, not a vendor — the same kind
 *  drives the first-party Responses API and the ChatGPT subscription
 *  backend, and which one it is follows the profile's baseUrl (and so
 *  the credential it resolves to). */
export type ProfileKind = "openai-compat" | "anthropic" | "openai-responses";

export interface ModelProfile {
	readonly kind: ProfileKind;
	readonly baseUrl?: string;
	readonly model: string;
	/** The env var NAME holding the key — never the key itself.
	 *  PH-1c (finding PH-F19): OPTIONAL — an absent apiKeyEnv means an
	 *  unauthenticated endpoint (a local Ollama, a LAN proxy); the
	 *  adapter receives a placeholder key, and the profile no longer
	 *  demands a dummy env var to exist. */
	readonly apiKeyEnv?: string;
	/** PH-1c.1: opt-in Anthropic prompt caching for this profile —
	 *  default off (a request-byte cost behavior never flips silently). */
	readonly promptCaching?: boolean;
	/** LT-1: milliseconds the model stream may go silent before the request
	 *  is aborted and retried. Default 120,000; 0 disables the watchdog. */
	readonly streamIdleMs?: number;
	/**
	 * The model's context window, in tokens, when YOU know it and nobody
	 * else publishes it.
	 *
	 * The registry carries a window only where a vendor states one, dated
	 * and sourced. DeepSeek states none: its /models endpoint returns ids
	 * only and its responses carry no window. Without a window the status
	 * row has no denominator and shows `ctx ?` rather than a percentage of
	 * a number nobody measured.
	 *
	 * Setting this makes the percentage real FOR YOU, and it is your claim,
	 * not ours — which is why it lives in your profile rather than in the
	 * registry, where every figure has to carry a source.
	 */
	readonly contextWindow?: number;
	/**
	 * What this endpoint FORWARDS to, when `baseUrl` is a local proxy — a URL
	 * (`https://gateway.example/v1`) or a name (`my gateway`). It never
	 * moves a request — they still go to `baseUrl`. The owner, 2026-09-23: a
	 * profile behind a local forwarder showed `@127.0.0.1:47821`, which says
	 * where the bytes go and not who is billed; the row now reads
	 * `@gateway.example via 127.0.0.1:47821`. CW-1: a URL here is also where
	 * the registry looks for this model's window when `baseUrl` has no row.
	 */
	readonly upstream?: string;
	/**
	 * Headers the endpoint needs on every request — a gateway that routes a
	 * conversation by a session header, say. `{session}` in a value becomes
	 * the kiso session's id, so one conversation keeps one id across /model
	 * and /resume, and two conversations never share one. Names are
	 * lower-cased. A credential header is refused by name: a key never lives
	 * in this file (`apiKeyEnv` and `kiso login` are the doors), and the
	 * framing headers belong to the adapter.
	 */
	readonly headers?: Readonly<Record<string, string>>;
}

/** Header names a profile may not set: credentials (a key never lives in the
 *  config file) and the framing the adapter owns. */
const REFUSED_HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key", "api-key", "cookie", "host", "content-length", "content-type", "transfer-encoding", "connection"]);

function parseHeaders(field: string, raw: unknown, fail: (key: string, why: string) => never): Record<string, string> {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(field, "expected an object of header names to string values");
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!/^[A-Za-z0-9-]+$/.test(name)) fail(`${field}.${name}`, "expected a header name of letters, digits and dashes");
		const lower = name.toLowerCase();
		if (REFUSED_HEADERS.has(lower)) fail(`${field}.${name}`, "a credential or framing header cannot be set here — the key comes from apiKeyEnv or kiso login");
		if (lower in out) fail(`${field}.${name}`, "named twice (header names are case-insensitive)");
		if (typeof value !== "string" || /[\r\n\0]/.test(value)) fail(`${field}.${name}`, "expected a one-line string value");
		out[lower] = value;
	}
	return out;
}

export interface AutoCompactConfig {
	readonly thresholdRatio: number;
}

export interface KisoConfig {
	readonly model?: string;
	readonly models?: Readonly<Record<string, ModelProfile>>;
	/** As written — an old name stays an old name here, and mode.ts
	 *  resolves it (resolveModeLayers), so /settings can say which. */
	readonly mode?: string;
	/** The don't-ask switch. Either config may set it: it only ever
	 *  refuses more, so a project turning it on lowers nothing. */
	readonly dontAsk?: boolean;
	readonly contextWindow?: number;
	readonly autoCompact?: AutoCompactConfig;
	/** ADR-0058 §8.4: false turns every task wake into a notice that waits
	 *  for your next message. Default on. */
	readonly taskWake?: boolean;
	readonly projectTrust?: "ask" | "never";
	/** DC-3 §3 rung 1, persisted. The terminal's light/dark, for terminals
	 *  that answer neither `CSI ? 996 n` nor OSC 11. USER-LEVEL ONLY: a
	 *  terminal is a property of the human sitting at one, not of the
	 *  repository they happen to have open, so the same setting in a
	 *  project file is a LOUD error rather than a silent win. `KISO_THEME`
	 *  still outranks it — the environment is the more local answer. */
	readonly theme?: "dark" | "light";
	/** 0.40.0: the catastrophe floor (floor.ts). Default on. USER-LEVEL
	 *  ONLY, and louder than theme about it: a repository that could lower
	 *  the floor would be the one thing the floor exists to stop. */
	readonly floor?: "catastrophe" | "off";
	/** kiso never serves its own credential store to a model, and these
	 *  files join it: no tool reads, writes or searches them, and no shell
	 *  line may name them (protected-shell.ts). Absolute, or `~/…`. USER-
	 *  LEVEL ONLY, as loud as floor: a project must never be able to change
	 *  what kiso guards. */
	readonly protectedPaths?: readonly string[];
	/** DT-1a: named acceptance checks a delegated task may reference —
	 *  user-authored (or trust-gated project) commands, run by the PARENT
	 *  in the child's worktree. A model never supplies a command; it names
	 *  one of these. `{ "test": "npm test", "lint": "npm run lint" }`. */
	readonly checks?: Readonly<Record<string, string>>;
	/** CS-1 (0.40.7): the evaluator scripts a delegated task may name —
	 *  absolute paths, `["/abs/path/to/evaluate.sh"]`. The PARENT runs the
	 *  one a task names with the child's worktree as its argument. A path
	 *  the user did not list is refused: the model chooses the task, so an
	 *  unlisted path could be an interpreter running code the child wrote.
	 *  Same layers as `checks`. */
	readonly evaluators?: readonly string[];
}

/** The resolved, merged config — project wins over user, both validated. */
export interface ResolvedConfig {
	readonly user: KisoConfig;
	readonly project: KisoConfig;
}

const KINDS: readonly string[] = ["openai-compat", "anthropic", "openai-responses"];

export class ConfigError extends Error {}

/** Parse + validate one config file. Broken JSON / invalid known values →
 *  ConfigError with the file path (LOUD). Unknown keys pass (forward compat). */
export function parseConfig(text: string, source: string): KisoConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new ConfigError(`config ${source}: broken JSON — ${err instanceof Error ? err.message : String(err)}`);
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new ConfigError(`config ${source}: the root must be a JSON object`);
	}
	const out: {
		model?: string;
		models?: Record<string, ModelProfile>;
		mode?: string;
		dontAsk?: boolean;
		contextWindow?: number;
		autoCompact?: AutoCompactConfig;
		taskWake?: boolean;
		projectTrust?: "ask" | "never";
		theme?: "dark" | "light";
		floor?: "catastrophe" | "off";
		protectedPaths?: readonly string[];
		checks?: Record<string, string>;
		evaluators?: string[];
	} = {};
	const obj = raw as Record<string, unknown>;
	const fail = (key: string, why: string): never => {
		throw new ConfigError(`config ${source}: ${key} — ${why}`);
	};
	if (obj.theme !== undefined) {
		// LOUD on both counts: an invalid value, and a valid value in the
		// wrong file. A theme silently ignored is the worst outcome here —
		// the human set it precisely because their terminal answers
		// nothing, so a quiet failure looks exactly like the defect it was
		// meant to fix.
		if (obj.theme !== "dark" && obj.theme !== "light") fail("theme", 'expected "dark" or "light"');
		if (source.startsWith("<cwd>")) fail("theme", "belongs in the USER config — a terminal is a property of the person at it, not of the project");
		out.theme = obj.theme as "dark" | "light";
	}
	if (obj.floor !== undefined) {
		if (obj.floor !== "catastrophe" && obj.floor !== "off") fail("floor", 'expected "catastrophe" or "off"');
		if (source.startsWith("<cwd>")) fail("floor", "belongs in the USER config — a project must never be able to lower the floor");
		out.floor = obj.floor as "catastrophe" | "off";
	}
	// Windows P3: absolute for the host — on Windows a drive path with
	// either separator (or a UNC share), never a drive-rooted `\x`, which
	// would mean a different file on every drive
	const windows = process.platform === "win32";
	const absolute = (p: string): boolean => (windows ? win32.isAbsolute(p) && !/^[\\/](?![\\/])/.test(p) : p.startsWith("/"));
	if (obj.protectedPaths !== undefined) {
		if (source.startsWith("<cwd>")) fail("protectedPaths", "belongs in the USER config — a project must never be able to change what kiso guards");
		if (!Array.isArray(obj.protectedPaths)) fail("protectedPaths", "expected an array of paths");
		for (const [i, p] of (obj.protectedPaths as unknown[]).entries()) {
			// a relative path would be read against whatever directory kiso
			// runs in — a different file in every project
			if (typeof p !== "string" || !(absolute(p) || p.startsWith("~/"))) fail(`protectedPaths[${i}]`, "expected an absolute path or one starting with ~/");
			// kiso protects FILES. A directory listed here would protect
			// nothing under it — a security setting that silently does
			// nothing — so it is refused where the person can see it.
			// (Read at every agent build: a directory created later is
			// caught at the next start or /reload.)
			const path = p as string;
			const full = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
			if (path.endsWith("/") || (windows && path.endsWith("\\")) || statSync(full, { throwIfNoEntry: false })?.isDirectory() === true) {
				fail(`protectedPaths[${i}]`, `${path} is a directory — kiso protects files, so list the files in it (for ~/.aws: "~/.aws/credentials", "~/.aws/config")`);
			}
		}
		out.protectedPaths = obj.protectedPaths as string[];
	}
	if (obj.checks !== undefined) {
		if (obj.checks === null || typeof obj.checks !== "object" || Array.isArray(obj.checks)) fail("checks", "expected an object of name → command");
		for (const [name, cmd] of Object.entries(obj.checks as Record<string, unknown>)) {
			if (!/^[A-Za-z0-9_-]+$/.test(name)) fail(`checks.${name}`, "a check name is letters, digits, _ or -");
			if (typeof cmd !== "string" || cmd.trim() === "") fail(`checks.${name}`, "expected a non-empty command string");
		}
		out.checks = obj.checks as Record<string, string>;
	}
	if (obj.evaluators !== undefined) {
		if (!Array.isArray(obj.evaluators)) fail("evaluators", "expected a list of absolute paths to evaluator scripts");
		for (const path of obj.evaluators as unknown[]) {
			if (typeof path !== "string" || !absolute(path)) fail("evaluators", `expected an absolute path, got ${JSON.stringify(path)}`);
		}
		out.evaluators = obj.evaluators as string[];
	}
	if (obj.model !== undefined) {
		if (typeof obj.model !== "string" || obj.model === "") fail("model", "expected a profile name or provider/model string");
		out.model = obj.model as string;
	}
	if (obj.models !== undefined) {
		// 0.46.2: a profile names where requests go and which of the
		// person's env vars is the key — a repository must never choose that
		if (source.startsWith("<cwd>")) fail("models", 'belongs in the USER config — a project may pick one of your profiles with "model", never define one');
		if (obj.models === null || typeof obj.models !== "object" || Array.isArray(obj.models)) fail("models", "expected an object of profiles");
		const models: Record<string, ModelProfile> = {};
		for (const [name, v] of Object.entries(obj.models as Record<string, unknown>)) {
			if (v === null || typeof v !== "object" || Array.isArray(v)) fail(`models.${name}`, "expected a profile object");
			const p = v as Record<string, unknown>;
			if (typeof p.kind !== "string" || !KINDS.includes(p.kind)) fail(`models.${name}.kind`, `expected one of ${KINDS.join(", ")}`);
			if (typeof p.model !== "string" || p.model === "") fail(`models.${name}.model`, "expected a model string");
			if (p.apiKeyEnv !== undefined && (typeof p.apiKeyEnv !== "string" || p.apiKeyEnv === ""))
				fail(`models.${name}.apiKeyEnv`, "expected an env var name (the config never stores keys); omit it entirely for an unauthenticated local endpoint");
			if (p.baseUrl !== undefined && typeof p.baseUrl !== "string") fail(`models.${name}.baseUrl`, "expected a string");
			if (p.promptCaching !== undefined && typeof p.promptCaching !== "boolean") fail(`models.${name}.promptCaching`, "expected a boolean");
			if (p.streamIdleMs !== undefined && (typeof p.streamIdleMs !== "number" || !Number.isFinite(p.streamIdleMs) || p.streamIdleMs < 0))
				fail(`models.${name}.streamIdleMs`, "expected a non-negative number of milliseconds (0 disables the stream watchdog)");
			// 0.39.2: `contextWindow` was DECLARED on this type, VALIDATED at
			// the top level, and CONSUMED by resolveContextWindow — which
			// prefers it over the global figure, with a comment saying why —
			// and it was never copied here. So it never reached anything: 70
			// of 70 profiles that declared one lost it in this object
			// literal. The cost was not the `ctx ?` on the status row but the
			// compaction threshold, which fell through to the 200k default
			// for every model the registry does not carry — a 1M-window model
			// compacting as though it had a fifth of its window. The
			// documented workaround for exactly that ("set contextWindow in
			// your profile") had never done anything.
			if (p.contextWindow !== undefined && (typeof p.contextWindow !== "number" || !Number.isFinite(p.contextWindow) || p.contextWindow <= 0))
				fail(`models.${name}.contextWindow`, "expected a positive token count");
			if (p.upstream !== undefined && (typeof p.upstream !== "string" || p.upstream.trim() === ""))
				fail(`models.${name}.upstream`, "expected the URL or name of what this endpoint forwards to");
			const headers = p.headers === undefined ? undefined : parseHeaders(`models.${name}.headers`, p.headers, fail);
			models[name] = {
				kind: p.kind as ProfileKind,
				model: p.model as string,
				...(typeof p.apiKeyEnv === "string" ? { apiKeyEnv: p.apiKeyEnv } : {}),
				...(typeof p.baseUrl === "string" ? { baseUrl: p.baseUrl } : {}),
				...(typeof p.promptCaching === "boolean" ? { promptCaching: p.promptCaching } : {}),
				...(typeof p.streamIdleMs === "number" ? { streamIdleMs: p.streamIdleMs } : {}),
				...(typeof p.contextWindow === "number" ? { contextWindow: p.contextWindow } : {}),
				...(typeof p.upstream === "string" ? { upstream: p.upstream.trim() } : {}),
				...(headers !== undefined ? { headers } : {}),
			};
		}
		out.models = models;
	}
	if (obj.mode !== undefined) {
		if (typeof obj.mode !== "string" || parseMode(obj.mode) === undefined) fail("mode", `expected one of ${MODE_VALUES.join(", ")}`);
		out.mode = obj.mode as string;
	}
	if (obj.dontAsk !== undefined) {
		if (typeof obj.dontAsk !== "boolean") fail("dontAsk", "expected true or false");
		out.dontAsk = obj.dontAsk as boolean;
	}
	if (obj.contextWindow !== undefined) {
		if (typeof obj.contextWindow !== "number" || !Number.isFinite(obj.contextWindow) || obj.contextWindow <= 0) {
			fail("contextWindow", "expected a positive token count");
		}
		out.contextWindow = obj.contextWindow as number;
	}
	if (obj.autoCompact !== undefined) {
		if (obj.autoCompact === null || typeof obj.autoCompact !== "object" || Array.isArray(obj.autoCompact)) fail("autoCompact", "expected { thresholdRatio }");
		const r = (obj.autoCompact as Record<string, unknown>).thresholdRatio;
		if (typeof r !== "number" || !Number.isFinite(r) || r <= 0 || r >= 1) fail("autoCompact.thresholdRatio", "expected a number strictly between 0 and 1");
		out.autoCompact = { thresholdRatio: r as number };
	}
	if (obj.taskWake !== undefined) {
		if (typeof obj.taskWake !== "boolean") fail("taskWake", "expected true or false");
		out.taskWake = obj.taskWake as boolean;
	}
	if (obj.projectTrust !== undefined) {
		if (obj.projectTrust !== "ask" && obj.projectTrust !== "never") fail("projectTrust", 'expected "ask" or "never" (there is deliberately no "always")');
		out.projectTrust = obj.projectTrust as "ask" | "never";
	}
	return out;
}

function readConfigFile(path: string, source: string): KisoConfig | null {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	return parseConfig(text, source);
}

/** The user config — never gated (the user's own file). */
export function loadUserConfig(): KisoConfig | null {
	return readConfigFile(join(kisoHome(), "config.json"), "~/.kiso/config.json");
}

/** The project config — read ONLY when the project's .kiso passed the E3
 *  trust gate (an untrusted project's config is never even read). */
export function loadProjectConfig(cwd: string, trusted: boolean): KisoConfig | null {
	if (!trusted) return null;
	return readConfigFile(join(cwd, ".kiso", "config.json"), "<cwd>/.kiso/config.json");
}

/** 0.46.2 — how much a tier lets run without a person, strictest first;
 *  `manual` sits with `default` (both ask). */
const MODE_LOOSENESS: Readonly<Record<Mode, number>> = { plan: 0, manual: 1, default: 1, "accept-edits": 2, "full-access": 3 };

/**
 * 0.46.2 — a repository's config may only make kiso STRICTER. A project
 * mode looser than the user level (the user config's mode, else
 * `default`) is refused, and a project may turn don't-ask on but never off
 * — including the switch the old `dontAsk` mode spelling carries. Flags
 * and env are the person's own choice and are not judged here.
 */
function assertProjectTightens(u: KisoConfig, p: KisoConfig): void {
	const where = "config <cwd>/.kiso/config.json";
	const base = parseMode(u.mode ?? "default");
	const proj = p.mode !== undefined ? parseMode(p.mode) : undefined;
	if (proj !== undefined && base !== undefined && MODE_LOOSENESS[proj.mode] > MODE_LOOSENESS[base.mode]) {
		const than = u.mode !== undefined ? `your config's "${u.mode}"` : "the default";
		throw new ConfigError(`${where}: mode — "${p.mode}" is looser than ${than}: a project can make the mode stricter, never looser`);
	}
	if (p.dontAsk === false) {
		throw new ConfigError(`${where}: dontAsk — a project can turn don't-ask on, never off`);
	}
	if (base?.dontAsk === true && proj !== undefined && proj.dontAsk !== true && p.dontAsk !== true) {
		throw new ConfigError(`${where}: mode — "${p.mode}" would turn off the don't-ask switch your config's "${u.mode}" carries: a project can turn don't-ask on, never off`);
	}
}

/** Merge: a project's keys win over the user's (each layer's own keys
 *  only) — except that a project may only tighten (assertProjectTightens). */
export function mergeConfigs(user: KisoConfig | null, project: KisoConfig | null): KisoConfig {
	const u = user ?? {};
	const p = project ?? {};
	assertProjectTightens(u, p);
	return {
		...(u.model !== undefined ? { model: u.model } : {}),
		...(p.model !== undefined ? { model: p.model } : {}),
		// 0.46.2: profiles come from the user config only — parseConfig
		// refuses a project's `models`, so there is nothing here to merge
		...(u.models !== undefined ? { models: u.models } : {}),
		...(u.mode !== undefined ? { mode: u.mode } : {}),
		...(p.mode !== undefined ? { mode: p.mode } : {}),
		...(u.dontAsk !== undefined ? { dontAsk: u.dontAsk } : {}),
		...(p.dontAsk !== undefined ? { dontAsk: p.dontAsk } : {}),
		...(u.contextWindow !== undefined ? { contextWindow: u.contextWindow } : {}),
		...(p.contextWindow !== undefined ? { contextWindow: p.contextWindow } : {}),
		...(u.autoCompact !== undefined ? { autoCompact: u.autoCompact } : {}),
		...(p.autoCompact !== undefined ? { autoCompact: p.autoCompact } : {}),
		...(u.taskWake !== undefined ? { taskWake: u.taskWake } : {}),
		...(p.taskWake !== undefined ? { taskWake: p.taskWake } : {}),
		...(u.projectTrust !== undefined ? { projectTrust: u.projectTrust } : {}),
		...(p.projectTrust !== undefined ? { projectTrust: p.projectTrust } : {}),
		// DT-1a: checks merge per name — a (trusted) project's check wins over the user's
		...(u.checks !== undefined || p.checks !== undefined ? { checks: { ...(u.checks ?? {}), ...(p.checks ?? {}) } } : {}),
		// CS-1: the evaluator lists join — either layer's script may be named
		...(u.evaluators !== undefined || p.evaluators !== undefined ? { evaluators: [...(u.evaluators ?? []), ...(p.evaluators ?? [])] } : {}),
	};
}

/** What a profile's sign-in actually IS. The two shapes are not
 *  interchangeable: an API key is a string an adapter holds, an OAuth
 *  sign-in is a token that expires and must be re-resolved per request. */
export type ProfileAuth =
	| { readonly type: "api-key"; readonly apiKey: string; readonly source: "store" | "env" | "none" }
	| { readonly type: "oauth"; readonly providerId: string; /** the access token's expiry (epoch ms) — past it, the next use renews */ readonly expires?: number };

/** Where a profile's sign-in comes from, or why it has none. The sign-in
 *  plan's resolve rule: a stored credential OWNS the provider (an
 *  unusable stored one is an error, never a silent fall back to env);
 *  with nothing stored, the profile's env var applies; a keyless profile
 *  (no apiKeyEnv — PH-1c, finding PH-F19) is an unauthenticated endpoint.
 *
 *  OR-1: a stored OAuth credential is USABLE only by an adapter that can
 *  drive one, which today is the Responses adapter's ChatGPT target. For
 *  every other kind it stays the same loud refusal it has always been —
 *  the caller is told which sign-in it has and which one it needs. */
export function authForProfile(name: string, p: ModelProfile): ProfileAuth {
	const providerId = providerIdOf(p.kind, p.baseUrl);
	if (providerId !== null) {
		let stored;
		try {
			stored = getCredential(providerId);
		} catch (err) {
			if (err instanceof AuthError) throw new ConfigError(`model ${name}: ${err.message}`);
			throw err;
		}
		if (stored !== undefined) {
			if (stored.type === "api-key") return { type: "api-key", apiKey: stored.key, source: "store" };
			if (p.kind === "openai-responses") {
				// 0.40.7: a sign-in whose renewal the endpoint REFUSED is over —
				// unavailable here, where /model reads it, not first at a turn
				if (stored.refreshRejectedAt !== undefined) {
					throw new ConfigError(`model ${name}: unavailable — the ${providerId} sign-in was refused when kiso tried to renew it: run \`kiso login ${providerId}\``);
				}
				return { type: "oauth", providerId, expires: stored.expires };
			}
			throw new ConfigError(`model ${name}: signed in to ${providerId} with OAuth, but this profile's adapter needs an API key — run \`kiso login ${providerId}\` with a key, or \`kiso logout ${providerId}\` to use the env var ${p.apiKeyEnv ?? "(none configured)"}`);
		}
	}
	// OR-2 (2026-09-09): a provider whose manifest takes NO API key (the ChatGPT
	// backend: authMethods ["oauth"]) is never an "unauthenticated endpoint" —
	// with nothing stored it is a profile waiting for its sign-in. Without this
	// the keyless rule below handed it a placeholder key, `/model` said
	// "available", and the adapter (an apiKey selects the first-party target)
	// would have sent an unauthenticated request to the wrong URL.
	if (providerId !== null && !manifestTakesKey(providerId)) {
		throw new ConfigError(`model ${name}: unavailable — not signed in: run \`kiso login ${providerId}\` (this provider takes no API key)`);
	}
	// 0.40.6: a GATEWAY's own key, stored for exactly this profile's origin
	// (`kiso login --endpoint <url>`). The rule a vendor credential follows:
	// stored first, the env var only when nothing is stored — and it goes to
	// that origin alone (credentials.ts endpointCredentialId).
	const endpointId = providerId === null ? endpointCredentialId(effectiveBaseUrl(p.kind, p.baseUrl)) : null;
	if (endpointId !== null) {
		let stored;
		try {
			stored = getCredential(endpointId);
		} catch (err) {
			if (err instanceof AuthError) throw new ConfigError(`model ${name}: ${err.message}`);
			throw err;
		}
		if (stored?.type === "api-key") return { type: "api-key", apiKey: stored.key, source: "store" };
	}
	if (p.apiKeyEnv === undefined) return { type: "api-key", apiKey: "none", source: "none" };
	const fromEnv = process.env[p.apiKeyEnv];
	if (fromEnv !== undefined) return { type: "api-key", apiKey: fromEnv, source: "env" };
	const hint =
		providerId !== null
			? `run \`kiso login ${providerId}\` or set the env var ${p.apiKeyEnv}`
			: endpointId !== null
				? `set the env var ${p.apiKeyEnv}, or run \`kiso login --endpoint ${endpointId.slice("endpoint:".length)}\``
				: `set the env var ${p.apiKeyEnv}`;
	throw new ConfigError(`model ${name}: unavailable — no credential: ${hint} (configs never store keys, only the env-var name)`);
}

/** OR-2: does the provider's manifest admit an API key (or no auth at all)?
 *  An unknown id answers yes — the keyless-endpoint rule stays for custom
 *  origins; only a manifest that says OAuth-only takes the sign-in path. */
function manifestTakesKey(providerId: string): boolean {
	const m = BUILTIN_MANIFESTS.find((x) => x.id === providerId);
	return m === undefined || m.authMethods.includes("api-key") || m.authMethods.includes("none");
}

/** The reason a profile is unavailable, for the surfaces that print it. */
export function unavailableReason(name: string, p: ModelProfile): string {
	try {
		authForProfile(name, p);
		return "";
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

/** A profile is available when a sign-in resolves for it — of EITHER
 *  shape: an OAuth-only profile is available, and calling the key-only
 *  resolver here would have declared it broken. */
export function profileAvailable(p: ModelProfile): boolean {
	try {
		authForProfile("?", p);
		return true;
	} catch {
		return false;
	}
}

/** The resolved runtime model — what the adapter is built from. Exactly
 *  one of the two sign-in fields is set: an OAuth profile has no key to
 *  hand over, and the caller must build the adapter from the token thunk
 *  instead (the compiler enforces the branch — `apiKey` is optional). */
export interface ResolvedModel {
	readonly name: string;
	readonly profile: ModelProfile;
	readonly apiKey?: string;
	/** OR-1: the provider whose stored OAuth sign-in this profile uses. */
	readonly oauthProviderId?: string;
}

/** "provider/model" direct write → a profile. */
export function directWriteProfile(value: string): ModelProfile | null {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return null;
	const kind = value.slice(0, slash);
	if (kind !== "openai-compat" && kind !== "anthropic" && kind !== "openai-responses") return null;
	return {
		kind,
		model: value.slice(slash + 1),
		// OR-1: a direct-write `openai-responses/…` names no baseUrl, so it
		// is the FIRST-PARTY target and its env var is OpenAI's. The
		// ChatGPT backend needs a baseUrl and a stored sign-in, which is a
		// configured profile's job, not a one-line direct write.
		apiKeyEnv: kind === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY",
	};
}

/**
 * Resolve the model — precedence: --model flag > env (the OPENAI_* /
 * ANTHROPIC_* key vars) > project config > user config > default (faux).
 * The flag names a profile or writes provider/model directly. A named
 * profile that does not exist is a LOUD ConfigError; an unavailable one
 * (env key missing) is refused with the reason — never a silent fallback.
 * Returns null when nothing resolves (faux mode).
 */
export function resolveModel(modelFlag: string | undefined, merged: KisoConfig): ResolvedModel | null {
	if (modelFlag !== undefined) {
		const direct = directWriteProfile(modelFlag);
		if (direct !== null) return resolveProfile(modelFlag, direct);
		const p = merged.models?.[modelFlag];
		if (p === undefined) throw new ConfigError(`unknown model profile: ${modelFlag} (see models in ~/.kiso/config.json)`);
		return resolveProfile(modelFlag, p);
	}
	// env beats config: a key in the environment names the provider.
	//
	// Astra F2: the credential goes through authForProfile like every other
	// route. This returned process.env.OPENAI_API_KEY directly, so the two
	// ways into the same adapter disagreed about which key a profile uses.
	// The safety property held by accident — the env key is not the stored
	// one — and an accident is not a rule. Now: the stored key at the
	// vendor's origin, the env key at a custom one, and a stored vendor key
	// is never forwarded to a custom environment URL.
	//
	// The env var is folded into the profile EXPLICITLY, so the resolved
	// endpoint is the profile's and the SDK never reads it again (F1).
	if (process.env.OPENAI_API_KEY !== undefined) {
		const profile = {
			kind: "openai-compat",
			model: process.env.OPENAI_MODEL ?? "gpt-4o",
			...(process.env.OPENAI_BASE_URL !== undefined ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
			apiKeyEnv: "OPENAI_API_KEY",
		} as ModelProfile;
		const auth = authForProfile(process.env.OPENAI_MODEL ?? "gpt-4o", profile);
		// The same total shape the config route returns (resolveProfile).
		// The `oauth` arm is unreachable from HERE — authForProfile returns
		// oauth only for an openai-responses profile and this route builds
		// an openai-compat one — but writing the union out beats a fallback
		// to the raw env var, which is the very disagreement F2 removes.
		return auth.type === "oauth"
			? { name: process.env.OPENAI_MODEL ?? "gpt-4o", profile, oauthProviderId: auth.providerId }
			: { name: process.env.OPENAI_MODEL ?? "gpt-4o", profile, apiKey: auth.apiKey };
	}
	if (process.env.ANTHROPIC_API_KEY !== undefined) {
		// Astra F2, the sibling. Same rule, same reason.
		const profile = {
			kind: "anthropic",
			model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
			apiKeyEnv: "ANTHROPIC_API_KEY",
			// PH-1c (finding PH-F19): symmetric with OPENAI_BASE_URL —
			// proxies and compat gateways serve the anthropic dialect too.
			...(process.env.ANTHROPIC_BASE_URL !== undefined ? { baseUrl: process.env.ANTHROPIC_BASE_URL } : {}),
		} as ModelProfile;
		const auth = authForProfile(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5", profile);
		// The same total shape the config route returns (resolveProfile).
		// The `oauth` arm is unreachable from HERE — authForProfile returns
		// oauth only for an openai-responses profile and this route builds
		// an anthropic one — but writing the union out beats a fallback
		// to the raw env var, which is the very disagreement F2 removes.
		return auth.type === "oauth"
			? { name: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5", profile, oauthProviderId: auth.providerId }
			: { name: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5", profile, apiKey: auth.apiKey };
	}
	// config (project wins over user) names a model; default is faux.
	const configured = merged.model;
	if (configured !== undefined) {
		const direct = directWriteProfile(configured);
		if (direct !== null) return resolveProfile(configured, direct);
		const p = merged.models?.[configured];
		if (p === undefined) throw new ConfigError(`config model "${configured}" is not a defined profile (see models in ~/.kiso/config.json)`);
		return resolveProfile(configured, p);
	}
	return null;
}

function resolveProfile(name: string, p: ModelProfile): ResolvedModel {
	// PH-1c (finding PH-F19): a keyless profile hands the adapter a
	// placeholder — the SDKs require SOME string; the endpoint ignores it.
	const auth = authForProfile(name, p);
	return auth.type === "oauth" ? { name, profile: p, oauthProviderId: auth.providerId } : { name, profile: p, apiKey: auth.apiKey };
}

/** Context window: env (KISO_CONTEXT_WINDOW) > config.contextWindow >
 *  default (200k — the caller's default). */
export function resolveContextWindow(merged: KisoConfig, profile?: ModelProfile): number | undefined {
	const fromEnv = Number.parseInt(process.env.KISO_CONTEXT_WINDOW ?? "", 10);
	if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
	// The PROFILE's window beats the global one: it is stated about a
	// specific model, and the global figure is a default for whatever is
	// selected. Env still beats both — someone who set it meant it.
	if (profile?.contextWindow !== undefined && profile.contextWindow > 0) return profile.contextWindow;
	return merged.contextWindow;
}

/** Auto-compact: env (KISO_AUTO_COMPACT) > config.autoCompact > off. An
 *  invalid env value is OFF (it set the env → it wins, and it is invalid). */
export function resolveAutoCompact(merged: KisoConfig): AutoCompactConfig | undefined {
	const raw = process.env.KISO_AUTO_COMPACT;
	if (raw !== undefined) {
		const ratio = Number.parseFloat(raw);
		if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return undefined;
		return { thresholdRatio: ratio };
	}
	return merged.autoCompact;
}

/** Project-trust policy: the USER config's projectTrust — "ask" (the E3
 *  gate, default) or "never" (the gate auto-refuses). The gate passes
 *  loadUserConfig() alone (trust-ui.ts): a project never relaxes its own
 *  gate, and it could not anyway, since an untrusted project's config is
 *  never read. */
export function resolveProjectTrustPolicy(merged: KisoConfig): "ask" | "never" {
	return merged.projectTrust ?? "ask";
}
