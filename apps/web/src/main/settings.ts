import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	applyEffortDeclarations,
	contextWindowOf,
	demoScript,
	authForProfile,
	effortOptions,
	loadUserConfig,
	mergeConfigs,
	preferences,
	profileAvailable,
	rememberEffort,
	startingEffort,
	type KisoConfig,
	type ModelProfile,
} from "@vincemakes/kiso-code/config";
import { MODE_LABEL, OFFERED_MODES } from "@vincemakes/kiso-code/policy";
import { lookupModelMetadata } from "@vincemakes/kiso-runtime/internal";
import type { ModelChoice, PermissionMode } from "./agent.js";
import { fauxSkip } from "./faux.js";
import { storeKey } from "./login.js";
import type { SettingsPatch, SettingsReply } from "../shared/settings.js";

/**
 * The web app's settings over the terminal's configuration: the profiles in
 * `~/.kiso/config.json` and the sign-in in `~/.kiso/auth.json` are read through
 * the `./config` door, never copied, so one login serves both products. What
 * the web app keeps of its own is small (`desktop.json` in the kiso home, the name from when it was a desktop app, kept so the choices carry over):
 * the profile new Works run on and the permission tier. The effort a profile
 * starts at is the terminal's own remembered one (`preferences.json`).
 * Changes reach Works opened after them; the tier reaches every Work at once
 * (it is process-wide until a Work carries its own, in S5). A Work can carry
 * its own profile and effort too (the composer's model pill): the host
 * rebuilds that Work between runs, from the same log.
 */

interface Own {
	readonly lastFolder?: string;
	readonly profile?: string;
	/** the tier new Works start with */
	readonly mode?: string;
	/** a tier per Work (session id), for Works whose tier was set */
	readonly tiers?: Readonly<Record<string, string>>;
	/** a profile and an effort per Work, for Works whose model was switched in the composer */
	readonly works?: Readonly<Record<string, Work>>;
	readonly recent?: readonly string[];
}

interface Work {
	readonly profile?: string;
	readonly effort?: string;
}

const MAX_RECENT = 10;
const SAFE_SESSION = /^[A-Za-z0-9._-]+$/;
/** Whether the model table says the profile's model reads images; unknown is no (nothing is sent that might be dropped). */
const readsImages = (p: ModelProfile): boolean => lookupModelMetadata(p.model, p.baseUrl)?.capabilities.inputModalities?.includes("image") === true;
const isTier = (value: unknown): value is PermissionMode => OFFERED_MODES.some((m) => m === value);

export class Settings {
	readonly #file: string;
	/** a scripted model (the proofs); the shared configuration is then not read */
	readonly #fixed: ModelChoice | null;
	/** the tier a Work starts with when nothing was set for it */
	#default: PermissionMode;
	/** the scripted tour, once started: a factory for its model (the demo script after the turns a Work has used) */
	#demo: ((skip: number) => ModelChoice) | null = null;

	constructor(home: string, fixed: ModelChoice | null, mode: PermissionMode) {
		this.#file = join(home, "desktop.json");
		this.#fixed = fixed;
		const saved = this.#read().mode;
		this.#default = isTier(saved) ? saved : mode;
	}

	/** The tier of one Work (read by the policy on every decision), else the one new Works start with. */
	tierOf(sessionId?: string): PermissionMode {
		const own = sessionId === undefined ? undefined : this.#read().tiers?.[sessionId];
		return isTier(own) ? own : this.#default;
	}

	/** Folders the person picked, newest first; and one more picked now. */
	recents(): readonly string[] {
		return this.#read().recent ?? [];
	}

	addRecent(path: string): void {
		this.write({ recent: [path, ...this.recents().filter((p) => p !== path)].slice(0, MAX_RECENT) });
	}

	/** Start the scripted tour: no key, the terminal's own demo script, for Works opened from now on. */
	async startDemo(): Promise<void> {
		const { createFauxProvider } = await import("@vincemakes/kiso-evals");
		this.#demo = (skip) => ({ kind: "adapter", adapter: createFauxProvider(demoScript().slice(skip)), model: "demo", route: "adapter" });
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

	/** The profile in use: the Work's own pick, else the person's pick for new Works, if it still exists, else the configuration's own default. */
	#chosen(config: KisoConfig, session?: string): string | null {
		const models = config.models ?? {};
		const own = session === undefined ? undefined : this.#read().works?.[session]?.profile;
		if (own !== undefined && models[own] !== undefined) return own;
		const picked = this.#read().profile;
		if (picked !== undefined && models[picked] !== undefined) return picked;
		return config.model !== undefined && models[config.model] !== undefined ? config.model : null;
	}

	/** The model a Work opened now runs on; throws, in words, when none can. */
	model(ctx?: { readonly sessionId: string; readonly sessionsDir: string }): ModelChoice {
		if (this.#fixed !== null) return this.#fixed;
		if (this.#demo !== null) return this.#demo(ctx === undefined ? 0 : fauxSkip(ctx.sessionsDir, ctx.sessionId));
		const config = this.#config();
		const name = this.#chosen(config, ctx?.sessionId);
		if (name === null) throw new Error("no model is configured: add a profile to ~/.kiso/config.json (see the terminal's docs) and choose it in Settings");
		const profile = config.models![name]!;
		const auth = authForProfile(name, profile);
		const effort = startingEffort(profile, this.#effortOf(name, ctx?.sessionId));
		return {
			kind: "profile",
			name,
			profile,
			auth: auth.type === "oauth" ? { type: "oauth", providerId: auth.providerId } : { type: "api-key", apiKey: auth.apiKey },
			contextWindow: contextWindowOf(profile, config) ?? undefined,
			...(effort !== null ? { reasoning: { thinking: "default", effort } as NonNullable<Extract<ModelChoice, { kind: "profile" }>["reasoning"]> } : {}),
		};
	}

	/** The effort a Work asked for (when it is one of the profile's levels), else the terminal's remembered one for the profile. */
	#effortOf(name: string, session?: string): string | undefined {
		const own = session === undefined ? undefined : this.#read().works?.[session]?.effort;
		return own ?? preferences().effort?.[name];
	}

	/** A Work's own model choice (to put back when its rebuild is refused). */
	workOf(session: string): Work | undefined {
		return this.#read().works?.[session];
	}

	restoreWork(session: string, work: Work | undefined): void {
		const { [session]: _, ...rest } = this.#read().works ?? {};
		this.write({ works: work === undefined ? rest : { ...rest, [session]: work } });
	}

	/** The person's own test-runner commands (`checks` in the configuration), for the compaction phase rule. */
	checks(): readonly string[] {
		return Object.values(this.#config().checks ?? {});
	}

	/** The names of the environment variables that hold a key: no shell child may inherit them. */
	secretEnvNames(): readonly string[] {
		return Object.values(this.#config().models ?? {}).flatMap((p) => (p.apiKeyEnv === undefined ? [] : [p.apiKeyEnv]));
	}

	/** What the home screen should offer: nothing, a key for a profile, a profile to add, or the tour already on. */
	#setup(config: KisoConfig, name: string | null): SettingsReply["setup"] {
		if (this.#fixed !== null) return "ready";
		if (this.#demo !== null) return "demo";
		const models = config.models ?? {};
		if (Object.keys(models).length === 0) return "noprofile";
		return name !== null && profileAvailable(models[name]!) ? "ready" : "signin";
	}

	/** Store a key for a profile (the terminal's credential file); a sign-in ends the tour. */
	saveKey(profile: string, key: unknown): void {
		storeKey(this.#config().models?.[profile], key);
		this.#demo = null;
		if (this.#read().profile === undefined) this.write({ profile });
	}

	snapshot(session?: string): SettingsReply {
		const config = this.#config();
		const models = config.models ?? {};
		const name = this.#chosen(config, session);
		const profile: ModelProfile | undefined = name === null ? undefined : models[name];
		const levels = profile === undefined ? null : effortOptions(profile);
		return {
			profiles: Object.entries(models).map(([n, p]) => ({ name: n, model: p.model, available: profileAvailable(p), images: readsImages(p) })),
			profile: name,
			effort: levels === null || name === null ? null : { ...levels, current: startingEffort(profile!, this.#effortOf(name, session)) },
			mode: this.tierOf(session),
			setup: this.#setup(config, name),
			modes: OFFERED_MODES.map((value) => ({ value, label: MODE_LABEL[value] })),
			signIn: name === null ? { ok: false, text: "No model is configured." } : signInOf(name, profile!),
		};
	}

	/** Apply a patch; returns the Work whose model binding it changed (the host rebuilds that Work), else null. */
	apply(patch: SettingsPatch): string | null {
		const config = this.#config();
		const session = patch.session !== undefined && SAFE_SESSION.test(patch.session) ? patch.session : undefined;
		if (session !== undefined && (patch.profile !== undefined || patch.effort !== undefined)) {
			// one Work's model: its own profile and effort, the new-Work default untouched
			const was = this.workOf(session) ?? {};
			const profileName = patch.profile !== undefined && config.models?.[patch.profile] !== undefined ? patch.profile : (was.profile ?? this.#chosen(config, session) ?? undefined);
			const profile = profileName === undefined ? undefined : config.models?.[profileName];
			const effort = patch.effort !== undefined && profile !== undefined && effortOptions(profile)?.levels.includes(patch.effort) === true ? patch.effort : patch.profile !== undefined ? undefined : was.effort;
			const next: Work = { ...(profileName !== undefined ? { profile: profileName } : {}), ...(effort !== undefined ? { effort } : {}) };
			if (next.profile === was.profile && next.effort === was.effort) return null;
			this.write({ works: { ...this.#read().works, [session]: next } });
			return session;
		}
		if (patch.profile !== undefined && config.models?.[patch.profile] !== undefined) {
			this.write({ profile: patch.profile });
			// choosing a profile that can run ends the tour
			if (profileAvailable(config.models[patch.profile]!)) this.#demo = null;
		}
		const name = patch.profile ?? this.#chosen(config);
		const profile = name === null ? undefined : config.models?.[name];
		if (patch.effort !== undefined && name !== null && profile !== undefined && effortOptions(profile)?.levels.includes(patch.effort) === true) rememberEffort(name, patch.effort);
		if (isTier(patch.mode)) {
			if (patch.session === undefined) {
				this.#default = patch.mode;
				this.write({ mode: patch.mode });
			} else if (SAFE_SESSION.test(patch.session)) this.write({ tiers: { ...this.#read().tiers, [patch.session]: patch.mode } });
		}
		return null;
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

