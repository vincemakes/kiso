import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	applyEffortDeclarations,
	authForProfile,
	effortOptions,
	loadUserConfig,
	mergeConfigs,
	preferences,
	profileAvailable,
	rememberEffort,
	resolveContextWindow,
	startingEffort,
	type KisoConfig,
	type ModelProfile,
} from "@vincemakes/kiso-code/config";
import { MODE_LABEL, OFFERED_MODES, getMode, setMode } from "@vincemakes/kiso-code/policy";
import type { ModelChoice, PermissionMode } from "./agent.js";
import type { SettingsPatch, SettingsReply } from "../shared/settings.js";

/**
 * The desktop's settings over the terminal's configuration: the profiles in
 * `~/.kiso/config.json` and the sign-in in `~/.kiso/auth.json` are read through
 * the `./config` door, never copied, so one login serves both products. What
 * the desktop keeps of its own is small (`desktop.json` in the kiso home):
 * the profile new Works run on and the permission tier. The effort a profile
 * starts at is the terminal's own remembered one (`preferences.json`).
 * Changes reach Works opened after them; the tier reaches every Work at once
 * (it is process-wide until a Work carries its own, in S5).
 */

interface Own {
	readonly lastFolder?: string;
	readonly profile?: string;
	readonly mode?: string;
}

export class Settings {
	readonly #file: string;
	/** a scripted model (the proofs); the shared configuration is then not read */
	readonly #fixed: ModelChoice | null;

	constructor(home: string, fixed: ModelChoice | null, mode: PermissionMode) {
		this.#file = join(home, "desktop.json");
		this.#fixed = fixed;
		const saved = this.#read().mode;
		setMode(saved !== undefined && OFFERED_MODES.some((m) => m === saved) ? (saved as PermissionMode) : mode);
	}

	#read(): Own {
		try {
			return JSON.parse(readFileSync(this.#file, "utf8")) as Own;
		} catch {
			return {};
		}
	}

	/** Merge into `desktop.json` (the folder memory lives there too). */
	write(patch: Own): void {
		try {
			mkdirSync(join(this.#file, ".."), { recursive: true, mode: 0o700 });
			writeFileSync(this.#file, `${JSON.stringify({ ...this.#read(), ...patch })}\n`, { mode: 0o600 });
		} catch {
			// a read-only home only loses the memory
		}
	}

	lastFolder(): string | undefined {
		return this.#read().lastFolder;
	}

	#config(): KisoConfig {
		const merged = mergeConfigs(loadUserConfig(), null);
		applyEffortDeclarations(merged);
		return merged;
	}

	/** The profile in use: the person's pick if it still exists, else the configuration's own default. */
	#chosen(config: KisoConfig): string | null {
		const models = config.models ?? {};
		const picked = this.#read().profile;
		if (picked !== undefined && models[picked] !== undefined) return picked;
		return config.model !== undefined && models[config.model] !== undefined ? config.model : null;
	}

	/** The model a Work opened now runs on; throws, in words, when none can. */
	model(): ModelChoice {
		if (this.#fixed !== null) return this.#fixed;
		const config = this.#config();
		const name = this.#chosen(config);
		if (name === null) throw new Error("no model is configured: add a profile to ~/.kiso/config.json (see the terminal's docs) and choose it in Settings");
		const profile = config.models![name]!;
		const auth = authForProfile(name, profile);
		const effort = startingEffort(profile, preferences().effort?.[name]);
		return {
			kind: "profile",
			name,
			profile,
			auth: auth.type === "oauth" ? { type: "oauth", providerId: auth.providerId } : { type: "api-key", apiKey: auth.apiKey },
			contextWindow: resolveContextWindow(config, profile),
			...(effort !== null ? { reasoning: { thinking: "default", effort } as NonNullable<Extract<ModelChoice, { kind: "profile" }>["reasoning"]> } : {}),
		};
	}

	/** The person's own test-runner commands (`checks` in the configuration), for the compaction phase rule. */
	checks(): readonly string[] {
		return Object.values(this.#config().checks ?? {});
	}

	/** The names of the environment variables that hold a key: no shell child may inherit them. */
	secretEnvNames(): readonly string[] {
		return Object.values(this.#config().models ?? {}).flatMap((p) => (p.apiKeyEnv === undefined ? [] : [p.apiKeyEnv]));
	}

	snapshot(): SettingsReply {
		const config = this.#config();
		const models = config.models ?? {};
		const name = this.#chosen(config);
		const profile: ModelProfile | undefined = name === null ? undefined : models[name];
		const levels = profile === undefined ? null : effortOptions(profile);
		return {
			profiles: Object.entries(models).map(([n, p]) => ({ name: n, model: p.model, available: profileAvailable(p) })),
			profile: name,
			effort: levels === null || name === null ? null : { ...levels, current: startingEffort(profile!, preferences().effort?.[name]) },
			mode: getMode(),
			modes: OFFERED_MODES.map((value) => ({ value, label: MODE_LABEL[value] })),
			signIn: name === null ? { ok: false, text: "No model is configured." } : signInOf(name, profile!),
		};
	}

	apply(patch: SettingsPatch): void {
		const config = this.#config();
		if (patch.profile !== undefined && config.models?.[patch.profile] !== undefined) this.write({ profile: patch.profile });
		const name = patch.profile ?? this.#chosen(config);
		const profile = name === null ? undefined : config.models?.[name];
		if (patch.effort !== undefined && name !== null && profile !== undefined && effortOptions(profile)?.levels.includes(patch.effort) === true) rememberEffort(name, patch.effort);
		if (patch.mode !== undefined && OFFERED_MODES.some((m) => m === patch.mode)) {
			setMode(patch.mode as PermissionMode);
			this.write({ mode: patch.mode });
		}
	}
}

/** Where a profile's sign-in comes from, in words; the secret is never part of it. */
function signInOf(name: string, profile: ModelProfile): { readonly ok: boolean; readonly text: string } {
	try {
		const auth = authForProfile(name, profile);
		if (auth.type === "oauth") return { ok: true, text: `Signed in with ${auth.providerId} (shared with the terminal)` };
		if (auth.source === "store") return { ok: true, text: "Signed in: a key stored by the terminal's login" };
		if (auth.source === "env") return { ok: true, text: `Using the key in the environment variable ${profile.apiKeyEnv ?? ""}` };
		return { ok: true, text: "This endpoint needs no key" };
	} catch (error) {
		return { ok: false, text: error instanceof Error ? error.message : String(error) };
	}
}

