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
/** One server, in the mcp.json `mcpServers` shape: a stdio `command`
 *  (with `args`, `env`, `cwd`) or a remote `url` (with `headers`). */
export interface McpServerConfig {
	readonly command?: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly cwd?: string;
	readonly url?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly disabled?: boolean;
}

export interface McpExtensionOptions {
	readonly secretEnvNames?: readonly string[];
	/** For a host: the servers, keyed by name as in mcp.json. Given (even
	 *  `{}`), no config file is read ($KISO_MCP_CONFIG and $KISO_HOME/mcp.json
	 *  are ignored), every entry is validated as a file entry is, and the
	 *  tool cache is neither read nor written, so a supplied server's tools
	 *  register when its connect settles. Omitted = the config file, as today. */
	readonly servers?: Readonly<Record<string, McpServerConfig>>;
}

declare const createMcpExtension: (opts?: McpExtensionOptions) => KisoExtension | Promise<KisoExtension>;
export default createMcpExtension;
