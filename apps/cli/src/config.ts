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
 *                        baseUrl?: string, model: string, apiKeyEnv: string } }
 *   mode?: "manual"|"default"|"accept-edits"|"plan"|"bypass"
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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { kisoHome } from "./state.js";
import type { Mode } from "./mode.js";
import { AuthError, getCredential, providerIdOf } from "./auth/credentials.js";

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
}

export interface AutoCompactConfig {
	readonly thresholdRatio: number;
}

export interface KisoConfig {
	readonly model?: string;
	readonly models?: Readonly<Record<string, ModelProfile>>;
	readonly mode?: Mode;
	readonly contextWindow?: number;
	readonly autoCompact?: AutoCompactConfig;
	readonly projectTrust?: "ask" | "never";
	/** DC-3 §3 rung 1, persisted. The terminal's light/dark, for terminals
	 *  that answer neither `CSI ? 996 n` nor OSC 11. USER-LEVEL ONLY: a
	 *  terminal is a property of the human sitting at one, not of the
	 *  repository they happen to have open, so the same setting in a
	 *  project file is a LOUD error rather than a silent win. `KISO_THEME`
	 *  still outranks it — the environment is the more local answer. */
	readonly theme?: "dark" | "light";
	/** DT-1a: named acceptance checks a delegated task may reference —
	 *  user-authored (or trust-gated project) commands, run by the PARENT
	 *  in the child's worktree. A model never supplies a command; it names
	 *  one of these. `{ "test": "npm test", "lint": "npm run lint" }`. */
	readonly checks?: Readonly<Record<string, string>>;
}

/** The resolved, merged config — project wins over user, both validated. */
export interface ResolvedConfig {
	readonly user: KisoConfig;
	readonly project: KisoConfig;
}

const KINDS: readonly string[] = ["openai-compat", "anthropic", "openai-responses"];
const MODES_LIST: readonly string[] = ["manual", "default", "accept-edits", "plan", "bypass"];

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
		mode?: Mode;
		contextWindow?: number;
		autoCompact?: AutoCompactConfig;
		projectTrust?: "ask" | "never";
		theme?: "dark" | "light";
		checks?: Record<string, string>;
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
	if (obj.checks !== undefined) {
		if (obj.checks === null || typeof obj.checks !== "object" || Array.isArray(obj.checks)) fail("checks", "expected an object of name → command");
		for (const [name, cmd] of Object.entries(obj.checks as Record<string, unknown>)) {
			if (!/^[A-Za-z0-9_-]+$/.test(name)) fail(`checks.${name}`, "a check name is letters, digits, _ or -");
			if (typeof cmd !== "string" || cmd.trim() === "") fail(`checks.${name}`, "expected a non-empty command string");
		}
		out.checks = obj.checks as Record<string, string>;
	}
	if (obj.model !== undefined) {
		if (typeof obj.model !== "string" || obj.model === "") fail("model", "expected a profile name or provider/model string");
		out.model = obj.model as string;
	}
	if (obj.models !== undefined) {
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
			models[name] = {
				kind: p.kind as ProfileKind,
				model: p.model as string,
				...(typeof p.apiKeyEnv === "string" ? { apiKeyEnv: p.apiKeyEnv } : {}),
				...(typeof p.baseUrl === "string" ? { baseUrl: p.baseUrl } : {}),
				...(typeof p.promptCaching === "boolean" ? { promptCaching: p.promptCaching } : {}),
			};
		}
		out.models = models;
	}
	if (obj.mode !== undefined) {
		if (typeof obj.mode !== "string" || !MODES_LIST.includes(obj.mode)) fail("mode", `expected one of ${MODES_LIST.join(", ")}`);
		out.mode = obj.mode as Mode;
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

/** Merge: project wins over user (each layer's own keys only). */
export function mergeConfigs(user: KisoConfig | null, project: KisoConfig | null): KisoConfig {
	const u = user ?? {};
	const p = project ?? {};
	return {
		...(u.model !== undefined ? { model: u.model } : {}),
		...(p.model !== undefined ? { model: p.model } : {}),
		...(u.models !== undefined ? { models: u.models } : {}),
		...(p.models !== undefined ? { models: { ...u.models, ...p.models } } : u.models !== undefined ? { models: u.models } : {}),
		...(u.mode !== undefined ? { mode: u.mode } : {}),
		...(p.mode !== undefined ? { mode: p.mode } : {}),
		...(u.contextWindow !== undefined ? { contextWindow: u.contextWindow } : {}),
		...(p.contextWindow !== undefined ? { contextWindow: p.contextWindow } : {}),
		...(u.autoCompact !== undefined ? { autoCompact: u.autoCompact } : {}),
		...(p.autoCompact !== undefined ? { autoCompact: p.autoCompact } : {}),
		...(u.projectTrust !== undefined ? { projectTrust: u.projectTrust } : {}),
		...(p.projectTrust !== undefined ? { projectTrust: p.projectTrust } : {}),
		// DT-1a: checks merge per name — a (trusted) project's check wins over the user's
		...(u.checks !== undefined || p.checks !== undefined ? { checks: { ...(u.checks ?? {}), ...(p.checks ?? {}) } } : {}),
	};
}

/** What a profile's sign-in actually IS. The two shapes are not
 *  interchangeable: an API key is a string an adapter holds, an OAuth
 *  sign-in is a token that expires and must be re-resolved per request. */
export type ProfileAuth =
	| { readonly type: "api-key"; readonly apiKey: string; readonly source: "store" | "env" | "none" }
	| { readonly type: "oauth"; readonly providerId: string };

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
			if (p.kind === "openai-responses") return { type: "oauth", providerId };
			throw new ConfigError(`model ${name}: signed in to ${providerId} with OAuth, but this profile's adapter needs an API key — run \`kiso login ${providerId}\` with a key, or \`kiso logout ${providerId}\` to use the env var ${p.apiKeyEnv ?? "(none configured)"}`);
		}
	}
	if (p.apiKeyEnv === undefined) return { type: "api-key", apiKey: "none", source: "none" };
	const fromEnv = process.env[p.apiKeyEnv];
	if (fromEnv !== undefined) return { type: "api-key", apiKey: fromEnv, source: "env" };
	const hint = providerId !== null ? `run \`kiso login ${providerId}\` or set the env var ${p.apiKeyEnv}` : `set the env var ${p.apiKeyEnv}`;
	throw new ConfigError(`model ${name}: unavailable — no credential: ${hint} (configs never store keys, only the env-var name)`);
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
	if (process.env.OPENAI_API_KEY !== undefined) {
		return {
			name: process.env.OPENAI_MODEL ?? "gpt-4o",
			profile: {
				kind: "openai-compat",
				model: process.env.OPENAI_MODEL ?? "gpt-4o",
				...(process.env.OPENAI_BASE_URL !== undefined ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
				apiKeyEnv: "OPENAI_API_KEY",
			},
			apiKey: process.env.OPENAI_API_KEY,
		};
	}
	if (process.env.ANTHROPIC_API_KEY !== undefined) {
		return {
			name: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
			profile: {
				kind: "anthropic",
				model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
				apiKeyEnv: "ANTHROPIC_API_KEY",
				// PH-1c (finding PH-F19): symmetric with OPENAI_BASE_URL —
				// proxies and compat gateways serve the anthropic dialect too.
				...(process.env.ANTHROPIC_BASE_URL !== undefined ? { baseUrl: process.env.ANTHROPIC_BASE_URL } : {}),
			},
			apiKey: process.env.ANTHROPIC_API_KEY,
		};
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

/** Mode: env (KISO_MODE) beats config.mode; the --mode flag is applied by
 *  main before this runs (flags are the top of the chain). */
export function resolveModeFromConfig(merged: KisoConfig): Mode | undefined {
	const fromEnv = process.env.KISO_MODE;
	if (fromEnv !== undefined) return fromEnv as Mode;
	return merged.mode;
}

/** Context window: env (KISO_CONTEXT_WINDOW) > config.contextWindow >
 *  default (200k — the caller's default). */
export function resolveContextWindow(merged: KisoConfig): number | undefined {
	const fromEnv = Number.parseInt(process.env.KISO_CONTEXT_WINDOW ?? "", 10);
	if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
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

/** Project-trust policy: config.projectTrust (project wins over user) —
 *  "ask" (the E3 gate, default) or "never" (the gate auto-refuses). */
export function resolveProjectTrustPolicy(merged: KisoConfig): "ask" | "never" {
	return merged.projectTrust ?? "ask";
}
