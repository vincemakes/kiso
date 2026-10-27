/**
 * The coding product's configuration and sign-in, as a library door: the
 * profiles in `~/.kiso/config.json`, the credential store, the adapter
 * options a profile resolves to, the efforts the person last picked, and the
 * per-project session folders. A host that is not the terminal (the desktop
 * app) reads the same login and the same Works as the terminal does.
 *
 * Almost read-only: the one write is `setCredential`, the terminal's own single
 * credential write path (an API key; no OAuth flow), and `scaffoldFirstRun`, the
 * terminal's first-run files. No project config (it needs the terminal's trust prompt). Nothing here
 * reaches the terminal's state or UI; a test holds that line.
 */

import { lookupContextWindow, lookupModelMetadata } from "@vincemakes/kiso-runtime/internal";
import { resolveContextWindow, type KisoConfig, type ModelProfile } from "./config.js";

export {
	ConfigError,
	applyEffortDeclarations,
	authForProfile,
	loadUserConfig,
	mergeConfigs,
	profileAvailable,
	resolveAutoCompact,
	resolveContextWindow,
	resolveModel,
	unavailableReason,
} from "./config.js";
export type { KisoConfig, ModelProfile, ProfileAuth, ProfileKind, ResolvedModel } from "./config.js";
export { adapterOptionsFor } from "./auth/adapter-options.js";
export type { AdapterAuth, AdapterOptions } from "./auth/adapter-options.js";
export { AuthError, KNOWN_PROVIDERS, endpointCredentialId, maskSecret, providerIdOf, setCredential } from "./auth/credentials.js";
export type { Credential } from "./auth/credentials.js";
export { preferences, rememberEffort, startingEffort } from "./preferences.js";
export { isFirstRun, scaffoldFirstRun } from "./first-run.js";
export { fauxScript as demoScript } from "./demo-script.js";
export { canonicalPath, claimProjectDir, projectDirFor, projectLayoutActive, sessionFolders } from "./projects.js";
export type { SessionFolder } from "./projects.js";

/**
 * The context window someone stated for a profile, or null when nobody has: the window the person set (the environment, the profile,
 * the configuration, in that order), else the metadata registry's for the profile's endpoint, else for the model's own identity.
 * The terminal's own chain, less what only a running terminal knows (a window an endpoint's refusal taught it).
 */
export function contextWindowOf(profile: Pick<ModelProfile, "model" | "baseUrl" | "contextWindow">, config?: KisoConfig): number | null {
	const set = resolveContextWindow(config ?? {}, profile as ModelProfile);
	return set ?? lookupContextWindow(profile.model, profile.baseUrl)?.tokens ?? null;
}

/** The reasoning levels a profile's route accepts, and the one it uses when none is sent; null when nobody states them. */
export function effortOptions(profile: Pick<ModelProfile, "model" | "baseUrl">): { readonly levels: readonly string[]; readonly default: string | null } | null {
	const effort = lookupModelMetadata(profile.model, profile.baseUrl)?.capabilities.reasoning?.effort ?? null;
	return effort === null ? null : { levels: effort.levels, default: effort.default };
}
