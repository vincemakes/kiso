/**
 * The coding product's configuration and sign-in, as a library door: the
 * profiles in `~/.kiso/config.json`, the credential store, the adapter
 * options a profile resolves to, the efforts the person last picked, and the
 * per-project session folders. A host that is not the terminal (the desktop
 * app) reads the same login and the same Works as the terminal does.
 *
 * Read-only on purpose: no sign-in flow, no credential setter, and no
 * project config (it needs the terminal's trust prompt). Nothing here
 * reaches the terminal's state or UI; a test holds that line.
 */

import { lookupModelMetadata } from "@vincemakes/kiso-runtime/internal";
import type { ModelProfile } from "./config.js";

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
export { AuthError, maskSecret, providerIdOf } from "./auth/credentials.js";
export type { Credential } from "./auth/credentials.js";
export { preferences, rememberEffort, startingEffort } from "./preferences.js";
export { canonicalPath, claimProjectDir, projectDirFor, projectLayoutActive, sessionFolders } from "./projects.js";
export type { SessionFolder } from "./projects.js";

/** The reasoning levels a profile's route accepts, and the one it uses when none is sent; null when nobody states them. */
export function effortOptions(profile: Pick<ModelProfile, "model" | "baseUrl">): { readonly levels: readonly string[]; readonly default: string | null } | null {
	const effort = lookupModelMetadata(profile.model, profile.baseUrl)?.capabilities.reasoning?.effort ?? null;
	return effort === null ? null : { levels: effort.levels, default: effort.default };
}
