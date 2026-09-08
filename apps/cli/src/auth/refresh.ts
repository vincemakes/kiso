/**
 * When a refresh happens (the sign-in plan §2): an OAuth credential that
 * expires within FRESH_WINDOW_MS is refreshed INSIDE the store's write path —
 * re-read under the lock first, so two kiso processes never refresh the same
 * token twice (the second sees the first's result). A failed refresh is a
 * named error ("signed out of <provider>: run `kiso login <provider>`"),
 * never a silent fall back to an API key or an env var.
 */
import { AuthError, modifyAuthFile, readAuthFile, type Credential } from "./credentials.js";
import type { OAuthCredential, OAuthFlow } from "./oauth/index.js";

export const FRESH_WINDOW_MS = 5 * 60_000;

export async function ensureFresh(providerId: string, flow: OAuthFlow, path?: string, now: number = Date.now(), tokenUrl?: string): Promise<Credential> {
	const current = readAuthFile(path).credentials[providerId];
	if (current === undefined) throw new AuthError(`not signed in to ${providerId}: run \`kiso login ${providerId}\``);
	if (current.type !== "oauth" || current.expires - now > FRESH_WINDOW_MS) return current;
	let refreshed: OAuthCredential | undefined;
	let error: Error | undefined;
	// the double check: another process may have refreshed while we waited for the lock
	const again = readAuthFile(path).credentials[providerId];
	if (again !== undefined && again.type === "oauth" && again.expires - now > FRESH_WINDOW_MS) return again;
	try {
		refreshed = await flow.refresh(current, tokenUrl);
	} catch (err) {
		error = err instanceof Error ? err : new Error(String(err));
	}
	if (refreshed === undefined) throw new AuthError(`signed out of ${providerId} (the token could not be refreshed: ${error?.message ?? "unknown"}) — run \`kiso login ${providerId}\``);
	const written = refreshed;
	modifyAuthFile((file) => {
		const latest = file.credentials[providerId];
		// if a concurrent refresh already wrote a fresher token, keep it
		if (latest !== undefined && latest.type === "oauth" && latest.expires > written.expires) return file;
		return { version: 1, credentials: { ...file.credentials, [providerId]: written } };
	}, path);
	return readAuthFile(path).credentials[providerId] as Credential;
}
