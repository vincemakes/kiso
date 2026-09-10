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
	// R2a — THE WRITE-BACK MAY NOT RESURRECT WHAT THE HUMAN REMOVED.
	//
	// `flow.refresh` is awaited outside the store lock, so anything can
	// happen to the file while it is on the wire. The old condition kept
	// only a LATER-EXPIRING entry, which asks the wrong question: an entry
	// deleted by `kiso logout` is not later-expiring, it is ABSENT, so the
	// branch fell through and wrote the old credential back — a sign-out
	// the human performed, undone by a network round trip they never saw.
	// A new login of another type was overwritten the same way: an api-key
	// entry is not an oauth entry with a later expiry either.
	//
	// The question that is actually being asked is "is this still the
	// generation I began from?", so that is what is compared: the refresh
	// token and the expiry captured BEFORE the await. Absent, a different
	// type, or a different generation — including the concurrent refresh
	// the old condition was written for — all leave the file alone.
	const began = current;
	modifyAuthFile((file) => {
		const latest = file.credentials[providerId];
		if (latest === undefined) return file; // logged out while we were on the wire
		if (latest.type !== "oauth") return file; // replaced by a login of another type
		if (latest.refresh !== began.refresh || latest.expires !== began.expires) return file; // a different generation
		return { version: 1, credentials: { ...file.credentials, [providerId]: written } };
	}, path);
	// What the FILE holds, not what this refresh produced: if the write was
	// declined the caller must be told the truth on disk, and an absent
	// entry is the not-signed-in error rather than an undefined cast to a
	// Credential.
	const after = readAuthFile(path).credentials[providerId];
	if (after === undefined) throw new AuthError(`not signed in to ${providerId}: run \`kiso login ${providerId}\``);
	return after;
}
