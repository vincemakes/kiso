/**
 * MG-1 — the identity layer above the adapter port (ADR-0051 Amendment 5
 * carries the wire half; this file carries WHO things are).
 *
 * Four concepts `openai-compat` used to conflate, separated: the PROVIDER
 * (a vendor identity), the API DIALECT it is driven through, the MODEL,
 * and (for custom endpoints) the ORIGIN. A provider chooses a dialect; it
 * is not itself a dialect. Manifests here are IDENTITY ONLY — no
 * capability data (capabilities are dated claims and live in the metadata
 * registry), no credential material ever.
 *
 * Lives under runtime/internal — the curated root surface does not move.
 */

import type { ContinuationScope } from "@vincemakes/kiso-core";

export interface ModelRef {
	readonly providerId: string;
	readonly apiId: string;
	readonly modelId: string;
}

export interface ProviderManifest {
	readonly id: string;
	/** A dated claim snapshot, not an API promise (date-stamped ordinal). */
	readonly revision: string;
	readonly authMethods: readonly string[];
	readonly apiIds: readonly string[];
	readonly defaultEndpoint?: string;
}

/** The six built-in identities. `custom` is the honest bucket for any
 *  OpenAI-compatible endpoint the origin table does not recognize —
 *  capabilities default to UNKNOWN there, never borrowed from OpenAI.
 *  `chatgpt` is a PROVIDER, not a dialect: the subscription backend
 *  serves the Responses dialect and nothing else, and it authenticates
 *  by OAuth only — there is no API key that reaches it. */
export const BUILTIN_MANIFESTS: readonly ProviderManifest[] = [
	{ id: "anthropic", revision: "2026-08-26.1", authMethods: ["api-key", "none"], apiIds: ["anthropic-messages"], defaultEndpoint: "https://api.anthropic.com" },
	{ id: "openai", revision: "2026-08-26.1", authMethods: ["api-key", "none"], apiIds: ["openai-chat", "openai-responses"], defaultEndpoint: "https://api.openai.com" },
	{ id: "chatgpt", revision: "2026-09-08.1", authMethods: ["oauth"], apiIds: ["openai-responses"], defaultEndpoint: "https://chatgpt.com/backend-api" },
	{ id: "deepseek", revision: "2026-08-26.1", authMethods: ["api-key", "none"], apiIds: ["openai-chat"], defaultEndpoint: "https://api.deepseek.com" },
	{ id: "zai", revision: "2026-08-26.1", authMethods: ["api-key", "none"], apiIds: ["openai-chat"], defaultEndpoint: "https://api.z.ai" },
	{ id: "custom", revision: "2026-08-26.1", authMethods: ["api-key", "none"], apiIds: ["openai-chat"] },
];

/** Known-origin recognition (the ratified Q3 answer): a compat profile
 *  whose baseUrl origin equals a built-in manifest's endpoint resolves to
 *  that provider identity — deterministic and manifest-driven, so a
 *  pre-preset DeepSeek envelope is not foreign the day presets ship. */
const KNOWN_ORIGINS: Readonly<Record<string, string>> = {
	"https://api.deepseek.com": "deepseek",
	"https://api.z.ai": "zai",
	"https://open.bigmodel.cn": "zai",
	"https://api.openai.com": "openai",
};

/** The ChatGPT backend's origin. Deliberately NOT in KNOWN_ORIGINS: that
 *  table resolves openai-CHAT profiles, and the subscription backend does
 *  not speak that dialect — a compat profile pointed at it is broken, not
 *  a `chatgpt` binding. */
const CHATGPT_ORIGIN = "https://chatgpt.com";

function isChatgptOrigin(baseUrl: string | undefined): boolean {
	if (baseUrl === undefined) return false;
	try {
		return new URL(baseUrl).origin === CHATGPT_ORIGIN;
	} catch {
		return false;
	}
}

/** The run's continuation scope, resolved from the live binding. An
 *  undefined provider (a directly injected SDK/faux adapter) is an
 *  UNSCOPED run: the kernel strips adapter-emitted continuation. */
export function resolveContinuationScope(
	provider: "anthropic" | "openai-compat" | "openai-responses" | undefined,
	model: string,
	baseUrl?: string,
): ContinuationScope | undefined {
	if (provider === undefined) return undefined;
	if (provider === "anthropic") {
		return { providerId: "anthropic", apiId: "anthropic-messages", modelId: model };
	}
	if (provider === "openai-responses") {
		// Two identities serve this dialect and no others, so there is no
		// `custom` bucket here: the ChatGPT origin, or OpenAI. This is the
		// ONLY place the rule lives — the adapter is HANDED the result
		// (agent.ts's openai-responses case) rather than re-deriving it,
		// so the stamping side and the replay side cannot disagree.
		return { providerId: isChatgptOrigin(baseUrl) ? "chatgpt" : "openai", apiId: "openai-responses", modelId: model };
	}
	if (baseUrl === undefined) {
		return { providerId: "openai", apiId: "openai-chat", modelId: model };
	}
	let origin: string;
	try {
		origin = new URL(baseUrl).origin;
	} catch {
		return { providerId: "custom", apiId: "openai-chat", modelId: model, endpoint: baseUrl };
	}
	const known = KNOWN_ORIGINS[origin];
	if (known !== undefined) return { providerId: known, apiId: "openai-chat", modelId: model };
	return { providerId: "custom", apiId: "openai-chat", modelId: model, endpoint: origin };
}
