/**
 * The OAuth interface — one shape for every subscription sign-in (the
 * sign-in plan, 2026-09-08, step 2). A flow knows how to obtain a credential
 * interactively and how to refresh one; the credential store owns
 * persistence; `ensureFresh` (../refresh.ts) owns WHEN a refresh happens.
 */
import type { Credential } from "../credentials.js";

export type OAuthCredential = Extract<Credential, { type: "oauth" }>;

export interface LoginInteraction {
	/** Print a line for the person signing in (the URL to open, the paste prompt). */
	readonly notify: (line: string) => void;
	/** Ask the person for a line (the pasted redirect URL or code when the
	 *  local callback cannot be reached); resolves "" when unavailable. */
	readonly prompt: (question: string) => Promise<string>;
	readonly signal?: AbortSignal;
	/** Test seam: the callback listener's host/port (defaults 127.0.0.1:1455). */
	readonly callback?: { readonly host: string; readonly port: number };
	/** Test seam: the token endpoint (defaults to the vendor's). */
	readonly tokenUrl?: string;
}

export interface OAuthFlow {
	readonly providerId: string;
	/** What the product says beside this method (an honest label). */
	readonly label: string;
	login(interaction: LoginInteraction): Promise<OAuthCredential>;
	refresh(credential: OAuthCredential, tokenUrl?: string): Promise<OAuthCredential>;
}
