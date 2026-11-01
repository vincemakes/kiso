import { KNOWN_PROVIDERS, endpointCredentialId, providerIdOf, setCredential, type ModelProfile } from "@vincemakes/kiso-code/config";
import { Refusal } from "./files.js";

/**
 * Storing a key for a profile, through the terminal's own credential door (`setCredential`: the same `auth.json`, the same single write
 * path). The key arrives from the page once, is written, and is never answered, logged or put in an error: every message here is fixed text.
 */

const MIN_KEY = 8;
const MAX_KEY = 4096;

/** The store id a profile's key belongs under: its vendor, else its gateway's origin; null for a profile that has no place for a key. */
export function credentialIdFor(profile: Pick<ModelProfile, "kind" | "baseUrl">): string | null {
	return providerIdOf(profile.kind, profile.baseUrl) ?? endpointCredentialId(profile.baseUrl);
}

export function storeKey(profile: ModelProfile | undefined, key: unknown): void {
	if (profile === undefined) throw new Refusal(404, "no such profile");
	if (typeof key !== "string" || key.length < MIN_KEY || key.length > MAX_KEY || !/^\S+$/.test(key)) throw new Refusal(400, "that does not look like a key");
	const id = credentialIdFor(profile);
	if (id === null) throw new Refusal(400, "this profile has no place for a key");
	// a ChatGPT sign-in is an OAuth flow with a browser: it stays in the terminal for now
	if (id === "chatgpt") throw new Refusal(400, "this sign-in is done in the terminal: kiso login chatgpt");
	if (!id.startsWith("endpoint:") && !KNOWN_PROVIDERS.includes(id)) throw new Refusal(400, "unknown provider");
	setCredential(id, { type: "api-key", key, savedAt: Date.now() });
}
