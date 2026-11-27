/**
 * Shape-only secret patterns (M2; the kiso-secrets spec § 4). A match must be
 * a credential BY SHAPE — a key format, a private-key block, credentials in a
 * URL, a secret assignment with a real-looking value — never by entropy
 * alone: precision over recall. A new shape is added by evidence (a named
 * format), never by widening a pattern.
 *
 * `findSecret` answers where the first secret is; callers decide what to do
 * (M2's admission drops the record and never writes the match anywhere).
 */

export type SecretKind =
	| "pem-private-key"
	| "aws-access-key"
	| "github-token"
	| "slack-token"
	| "provider-key"
	| "google-api-key"
	| "jwt"
	| "url-credentials"
	| "assignment";

export interface SecretMatch {
	readonly kind: SecretKind;
	readonly start: number;
	readonly end: number;
}

/** A value that names a secret without being one. */
const PLACEHOLDER = /^(?:\$\{.*\}|\$[A-Z_][A-Z0-9_]*|<.*>|\{\{.*\}\}|x+|\*+|\.+|changeme|example|placeholder|redacted|your[_-].*|process\.env\..*)$/i;

const PATTERNS: readonly { readonly kind: SecretKind; readonly re: RegExp; readonly value?: number }[] = [
	{ kind: "pem-private-key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
	{ kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
	{ kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82})\b/g },
	{ kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9]+(?:-[A-Za-z0-9]+){2,}/g },
	// the current provider forms: Anthropic, OpenAI project keys, and the plain
	// sk- keys of OpenAI-compatible routes (DeepSeek and others)
	{ kind: "provider-key", re: /\bsk-(?:ant-[A-Za-z0-9_-]{20,}|proj-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{32,})/g },
	{ kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
	{ kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
	{ kind: "url-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'`]+:([^\s/@"'`]+)@[^\s/"'`]+/gi, value: 1 },
	// a secret-named key assigned a value that mixes letters and digits
	{ kind: "assignment", re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*(["']?)([^\s"'`,;)]{8,})\1/gi, value: 2 },
];

const realValue = (v: string): boolean => !PLACEHOLDER.test(v) && /[A-Za-z]/.test(v) && /[0-9]/.test(v);

/** The first secret in `text` by position, or null. */
export function findSecret(text: string): SecretMatch | null {
	let best: SecretMatch | null = null;
	for (const { kind, re, value } of PATTERNS) {
		re.lastIndex = 0;
		for (let m = re.exec(text); m !== null; m = re.exec(text)) {
			if (value !== undefined && !realValue(m[value] ?? "")) continue;
			if (best === null || m.index < best.start) best = { kind, start: m.index, end: m.index + m[0].length };
			break;
		}
	}
	return best;
}
