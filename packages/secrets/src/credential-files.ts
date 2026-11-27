/**
 * The credential-file set, moved verbatim from tools-node's corpus.ts
 * (the kiso-secrets leaf, spec 2026-11-27). Its rulings are unchanged; only
 * the path separator became a parameter, since this package imports nothing.
 */

/** THE CREDENTIAL SET — files whose CONVENTIONAL PURPOSE is to hold
 *  credentials. That class is the rule; the list is its application, and
 *  the next candidate is judged by the class rather than by resemblance.
 *  Changes to this list are RULINGS, not edits.
 *
 *  Enumerated rather than matched by prefix: `.env*` as a prefix would
 *  also swallow `.environment` and `.envoy.yaml`, which are ordinary
 *  files that happen to start the same way.
 *
 *  IN, and why:
 *    `.env`, `.env.*`   the convention itself
 *    `.envrc`           direnv — routinely `export AWS_SECRET_...`
 *    `.netrc`           machine credentials, by definition
 *    id_rsa, id_dsa,    private keys, by name. Their `.pub` counterparts
 *    id_ecdsa,          are different names and stay searchable, which is
 *    id_ed25519         correct: a public key is public.
 *    *.pem              the same, by extension
 *    `.npmrc`, `.pypirc`, `.git-credentials`, `.htpasswd` — RO-F4, the
 *                       owner's 0.40.7 ruling. `.npmrc` was OUT here ("tokens
 *                       in it are normally `${VAR}` placeholders") while the
 *                       read-only shell rule (0.40.0, B4) already called it a
 *                       credential: two lists that disagreed, so a search
 *                       exposed what `cat` asked about. One set now, used by
 *                       both; a literal `_authToken=` is common enough.
 *    and, by PATH (a name alone would be too broad — `config`,
 *    `credentials`): `.aws/credentials`, `.config/gh/hosts.yml`,
 *    `.docker/config.json`, `.kube/config` (isCredentialPath)
 *
 *  OUT, deliberately, so the omissions are decisions and not oversights:
 *    `*.key`    too many non-secret uses to be a credential by name
 *
 *  The corpus skips them, so an incidental hit from a search for "KEY"
 *  is not exposed. Since #31 (ADR-0058 Amendment 21) kiso's file tools
 *  also refuse an explicit read of one (`isSecretLocation`), inside the
 *  workspace or out: a secret never reaches the provider by itself. */
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);
const CREDENTIAL_NAMES = new Set([".envrc", ".netrc", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".npmrc", ".pypirc", ".git-credentials", ".htpasswd"]);
const CREDENTIAL_PATHS = ["/.aws/credentials", "/.config/gh/hosts.yml", "/.docker/config.json", "/.kube/config"];

/** RO-F4: the credential files named by their DIRECTORY as well — a path
 *  (absolute or root-relative), folded to lower case as a case-insensitive
 *  disk would. The read-only shell rule asks this same question.
 *  `separator` is the host's path separator: this package imports nothing,
 *  so the caller passes it (tools-node passes node:path's `sep`). */
export function isCredentialPath(path: string, separator = "/"): boolean {
	const folded = `/${path.split(separator).join("/")}`.toLowerCase();
	return CREDENTIAL_PATHS.some((s) => folded.endsWith(s));
}

export function isCredentialName(name: string): boolean {
	if (ENV_TEMPLATES.has(name)) return false;
	if (name === ".env" || name.startsWith(".env.")) return true;
	if (CREDENTIAL_NAMES.has(name)) return true;
	return name.endsWith(".pem");
}
