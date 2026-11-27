# @vincemakes/kiso-secrets

One secret detector for kiso. It has zero dependencies and zero imports, so tools-node, the runtime and the MCP
extension's bundle all use the same rules.

- `isCredentialName(name)` and `isCredentialPath(path, separator?)`: the credential-file set (files whose
  conventional purpose is to hold credentials).
- `SHELL_STRIP_EXACT` and `strippedShellEnv(env, secretNames)`: the child-environment strip.
- `isSecretLocation(path, { home, kisoHome, separator? })`: the secret-location deny list (the SSH directory,
  GnuPG, the OS keychain and credential stores, browser profile roots, known password-manager stores, the
  credential-file set, kiso's own credentials), by name only.
- `findSecret(text)`: the first secret by shape (private-key blocks, provider and cloud key formats, JWTs,
  credentials in URLs, secret assignments with real-looking values), or `null`. It matches by shape only, never by
  entropy alone.

The package answers whether something is a secret; what to do with a hit is the caller's policy.
