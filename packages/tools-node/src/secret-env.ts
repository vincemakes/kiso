/**
 * THE child-environment strip — ONE implementation, both children.
 *
 * bootstrap #3 (finding #7) established the rule for shell children: the
 * agent's own provider surface (both families' keys, base URLs and model
 * choices) plus the generic API-key / auth-token patterns that cover other
 * providers. Everything else passes through untouched.
 *
 * Astra F7 then showed the rule was incomplete AND duplicated. Incomplete:
 * a profile's `apiKeyEnv` can be ANY name — `REVIEW_PROVIDER_TOKEN` ends in
 * neither suffix — so the key a profile authenticates with survived into
 * the child. Duplicated: the MCP extension carried its own copy of the list
 * with a "keep in sync" comment, and a comment is not a mechanism; the copy
 * did not learn the declared names and MCP stdio children kept leaking.
 *
 * The names must come from the caller because only the config knows which
 * env vars are secrets. No names declared = exactly the pre-F7 behaviour,
 * which is what a standalone extension load gets.
 *
 * This module imports NOTHING on purpose: the MCP extension is an esbuild
 * bundle, and a shared rule must not drag a package graph across with it.
 */

/** The explicit credential list stripped from every child. */
export const SHELL_STRIP_EXACT: ReadonlySet<string> = new Set([
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"ANTHROPIC_BASE_URL",
	"OPENAI_BASE_URL",
	"ANTHROPIC_MODEL",
	"OPENAI_MODEL",
]);

/** The environment a child process may see: `env` minus the exact list,
 *  minus every DECLARED secret name, minus the two suffix families. */
export function strippedShellEnv(
	env: Record<string, string | undefined>,
	secretNames: readonly string[] = [],
): Record<string, string | undefined> {
	const declared = new Set(secretNames);
	const out: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(env)) {
		if (SHELL_STRIP_EXACT.has(key)) continue;
		if (declared.has(key)) continue;
		if (key.endsWith("_API_KEY") || key.endsWith("_AUTH_TOKEN")) continue;
		if (value !== undefined) out[key] = value;
	}
	return out;
}
