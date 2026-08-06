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
 *                      direct write (provider: "openai-compat" | "anthropic")
 *   models?: { [name]: { kind: "openai-compat"|"anthropic",
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

export type ProfileKind = "openai-compat" | "anthropic";

export interface ModelProfile {
	readonly kind: ProfileKind;
	readonly baseUrl?: string;
	readonly model: string;
	/** The env var NAME holding the key — never the key itself. */
	readonly apiKeyEnv: string;
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
}

/** The resolved, merged config — project wins over user, both validated. */
export interface ResolvedConfig {
	readonly user: KisoConfig;
	readonly project: KisoConfig;
}

const KINDS: readonly string[] = ["openai-compat", "anthropic"];
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
	} = {};
	const obj = raw as Record<string, unknown>;
	const fail = (key: string, why: string): never => {
		throw new ConfigError(`config ${source}: ${key} — ${why}`);
	};
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
			if (typeof p.apiKeyEnv !== "string" || p.apiKeyEnv === "") fail(`models.${name}.apiKeyEnv`, "expected an env var name (the config never stores keys)");
			if (p.baseUrl !== undefined && typeof p.baseUrl !== "string") fail(`models.${name}.baseUrl`, "expected a string");
			models[name] = {
				kind: p.kind as ProfileKind,
				model: p.model as string,
				apiKeyEnv: p.apiKeyEnv as string,
				...(typeof p.baseUrl === "string" ? { baseUrl: p.baseUrl } : {}),
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
	};
}

/** A profile is available when its apiKeyEnv var is set (the key exists). */
export function profileAvailable(p: ModelProfile): boolean {
	return process.env[p.apiKeyEnv] !== undefined;
}

/** The resolved runtime model — what the adapter is built from. */
export interface ResolvedModel {
	readonly name: string;
	readonly profile: ModelProfile;
	readonly apiKey: string;
}

/** "provider/model" direct write → a profile. */
export function directWriteProfile(value: string): ModelProfile | null {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return null;
	const kind = value.slice(0, slash);
	if (kind !== "openai-compat" && kind !== "anthropic") return null;
	return {
		kind,
		model: value.slice(slash + 1),
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
	if (!profileAvailable(p)) {
		throw new ConfigError(`model ${name}: unavailable — the env var ${p.apiKeyEnv} is not set (configs never store keys, only the env-var name)`);
	}
	return { name, profile: p, apiKey: process.env[p.apiKeyEnv] as string };
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
