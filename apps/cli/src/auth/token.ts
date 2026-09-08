/**
 * OR-1 — the token thunk the Responses adapter's ChatGPT target is built
 * from.
 *
 * The adapter awaits this ONCE PER REQUEST, which is the whole point: a
 * subscription token expires on the hour, and a session that resolved its
 * token at startup would die mid-task. `ensureFresh` re-reads the store
 * under its own lock and refreshes only inside the expiry window, so the
 * per-request call is a file read in the common case and a refresh
 * exactly when one is due.
 *
 * A failure here is the store's own named error ("signed out of chatgpt:
 * run `kiso login chatgpt`") — the adapter turns it into a failed turn
 * rather than guessing at a fallback credential.
 */
import type { ResponsesOAuthToken } from "@vincemakes/kiso-provider-openai-responses";
import { AuthError } from "./credentials.js";
import { ensureFresh } from "./refresh.js";

/** The OAuth flows a provider id can be refreshed through. One entry
 *  today; a second sign-in registers here rather than in every caller. */
async function flowFor(providerId: string): Promise<import("./oauth/index.js").OAuthFlow> {
	if (providerId === "chatgpt") {
		const { chatgptFlow } = await import("./oauth/chatgpt.js");
		return chatgptFlow;
	}
	throw new AuthError(`no OAuth flow is registered for ${providerId}`);
}

export function oauthTokenThunk(providerId: string): () => Promise<ResponsesOAuthToken> {
	return async () => {
		const credential = await ensureFresh(providerId, await flowFor(providerId));
		if (credential.type !== "oauth") {
			throw new AuthError(`${providerId}: the stored credential is an API key, not a sign-in — run \`kiso login ${providerId}\``);
		}
		if (credential.accountId === undefined) {
			// The backend refuses a request without the account header, so
			// a token that carries no account id is unusable — said here,
			// once, rather than as an opaque 400 per turn.
			throw new AuthError(`${providerId}: the stored sign-in carries no account id — run \`kiso login ${providerId}\` again`);
		}
		return { access: credential.access, accountId: credential.accountId };
	};
}
