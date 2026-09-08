/** PKCE (RFC 7636) with S256 — the two values every browser sign-in needs.
 *  node:crypto only; base64url without padding, as the spec requires. */
import { createHash, randomBytes } from "node:crypto";

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function generatePkce(): { readonly verifier: string; readonly challenge: string } {
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

export function randomState(): string {
	return randomBytes(16).toString("hex");
}
