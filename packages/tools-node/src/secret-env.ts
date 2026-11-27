/**
 * THE child-environment strip lives in @vincemakes/kiso-secrets (one secret
 * detector for kiso). This subpath re-exports it as tools-node's public API
 * (`@vincemakes/kiso-tools-node/secret-env`), permanently.
 */
export { SHELL_STRIP_EXACT, strippedShellEnv } from "@vincemakes/kiso-secrets";
