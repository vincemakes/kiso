/**
 * The published type surface of @vincemakes/kiso-mcp-ext: the default
 * export is the FACTORY (the same contract the user-layer disk loader
 * accepts — a KisoExtension or a factory returning one). The type import
 * from kiso-core is compile-time only — the shipped bundle is
 * self-contained, zero runtime dependencies.
 */
import type { KisoExtension } from "@vincemakes/kiso-core";

/** Astra F7: the env-var NAMES the host's configured model profiles
 *  authenticate with. Only the host's config knows them, so the host
 *  declares them; every stdio child is spawned without them. Omitted (a
 *  standalone extension load) = the exact-list and suffix rules alone. */
export interface McpExtensionOptions {
	readonly secretEnvNames?: readonly string[];
}

declare const createMcpExtension: (opts?: McpExtensionOptions) => KisoExtension | Promise<KisoExtension>;
export default createMcpExtension;
