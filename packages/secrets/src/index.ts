/**
 * @vincemakes/kiso-secrets — one secret detector for kiso. Zero dependencies
 * and zero imports: tools-node, the runtime and the MCP extension's bundle
 * all use it, and a shared rule must not drag a package graph across.
 */
export { isCredentialName, isCredentialPath } from "./credential-files.js";
export { SHELL_STRIP_EXACT, strippedShellEnv } from "./secret-env.js";
export { isSecretLocation, type SecretLocationContext } from "./locations.js";
export { findSecret, type SecretKind, type SecretMatch } from "./content.js";
