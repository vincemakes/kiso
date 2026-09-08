/**
 * The ChatGPT subscription sign-in — the flow the reference implementation
 * uses (pi, `packages/ai/src/auth/oauth/openai-codex.ts` @ a79b37334, MIT,
 * Mario Zechner; the constants and the sequence are reused as design, the
 * code is ours). What is known and not known about it is recorded in
 * kiso-doc/kiso-provider-mainline-2026-09-08.md §3; the owner accepted the
 * terms risk on 2026-09-08. The product labels it as unofficial.
 *
 * Sequence: PKCE + state → the authorize URL (opened or printed) → the
 * callback on 127.0.0.1:1455 (state checked; or a pasted redirect URL /
 * code when the port cannot be bound) → the code exchanged at the token
 * endpoint → {access, refresh, expires, accountId} where accountId is the
 * `chatgpt_account_id` claim of the access token's JWT payload (a token
 * without it is refused: the backend needs the header).
 *
 * The token is only usable against the ChatGPT backend's Responses
 * endpoint — the Responses adapter is the second half of this step.
 */
import { createServer } from "node:http";
import type { LoginInteraction, OAuthCredential, OAuthFlow } from "./index.js";
import { generatePkce, randomState } from "./pkce.js";

export const CHATGPT = {
	providerId: "chatgpt",
	clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
	authorizeUrl: "https://auth.openai.com/oauth/authorize",
	tokenUrl: "https://auth.openai.com/oauth/token",
	redirectUri: "http://localhost:1455/auth/callback",
	scope: "openid profile email offline_access",
	jwtClaimPath: "https://api.openai.com/auth",
	originator: "kiso",
} as const;

export interface AuthorizationFlow {
	readonly verifier: string;
	readonly state: string;
	readonly url: string;
}

export function createAuthorizationFlow(redirectUri: string = CHATGPT.redirectUri): AuthorizationFlow {
	const { verifier, challenge } = generatePkce();
	const state = randomState();
	const url = new URL(CHATGPT.authorizeUrl);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", CHATGPT.clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("scope", CHATGPT.scope);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("id_token_add_organizations", "true");
	url.searchParams.set("codex_cli_simplified_flow", "true");
	url.searchParams.set("originator", CHATGPT.originator);
	return { verifier, state, url: url.toString() };
}

/** A pasted redirect URL, a `code#state` pair, a query string, or a bare code. */
export function parseAuthorizationInput(input: string): { readonly code?: string | undefined; readonly state?: string | undefined } {
	const value = input.trim();
	if (value === "") return {};
	try {
		const url = new URL(value);
		return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
	} catch {
		// not a URL
	}
	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
	}
	return { code: value };
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	try {
		return JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function accountIdOf(accessToken: string): string | null {
	const payload = decodeJwtPayload(accessToken);
	const auth = payload?.[CHATGPT.jwtClaimPath] as { chatgpt_account_id?: unknown } | undefined;
	const id = auth?.chatgpt_account_id;
	return typeof id === "string" && id.length > 0 ? id : null;
}

interface TokenSet {
	readonly access: string;
	readonly refresh: string;
	readonly expires: number;
}

async function readTokenResponse(response: Response, operation: "exchange" | "refresh"): Promise<TokenSet> {
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`ChatGPT sign-in: token ${operation} failed (${response.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
	}
	const json = (await response.json()) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
	if (typeof json.access_token !== "string" || typeof json.refresh_token !== "string" || typeof json.expires_in !== "number") {
		throw new Error(`ChatGPT sign-in: token ${operation} response is missing fields`);
	}
	return { access: json.access_token, refresh: json.refresh_token, expires: Date.now() + json.expires_in * 1000 };
}

export async function exchangeCode(code: string, verifier: string, redirectUri: string, tokenUrl: string = CHATGPT.tokenUrl, signal?: AbortSignal): Promise<TokenSet> {
	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "authorization_code", client_id: CHATGPT.clientId, code, code_verifier: verifier, redirect_uri: redirectUri }),
		...(signal ? { signal } : {}),
	});
	return readTokenResponse(response, "exchange");
}

export async function refreshTokens(refresh: string, tokenUrl: string = CHATGPT.tokenUrl): Promise<TokenSet> {
	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "refresh_token", client_id: CHATGPT.clientId, refresh_token: refresh }),
	});
	return readTokenResponse(response, "refresh");
}

export function credentialFromTokens(tokens: TokenSet): OAuthCredential {
	const accountId = accountIdOf(tokens.access);
	if (accountId === null) throw new Error("ChatGPT sign-in: the access token carries no chatgpt_account_id claim — signed in to something the backend will not serve");
	return { type: "oauth", access: tokens.access, refresh: tokens.refresh, expires: tokens.expires, accountId, savedAt: Date.now() };
}

const PAGE = (title: string, body: string): string => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;padding:2rem"><h1>${title}</h1><p>${body}</p></body>`;

/** The local callback: one code for one state, or null when the port cannot
 *  be bound (the paste path takes over). */
export function startCallbackServer(state: string, host: string, port: number): Promise<{ readonly waitForCode: () => Promise<string | null>; readonly close: () => void } | null> {
	return new Promise((resolve) => {
		let settle: ((code: string | null) => void) | undefined;
		const waited = new Promise<string | null>((r) => {
			settle = r;
		});
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "", `http://${host}`);
			const reply = (status: number, title: string, body: string): void => {
				res.statusCode = status;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(PAGE(title, body));
			};
			if (url.pathname !== "/auth/callback") return reply(404, "Not found", "This is kiso's sign-in callback.");
			if (url.searchParams.get("state") !== state) return reply(400, "State mismatch", "The sign-in did not start from this kiso. Start again.");
			const code = url.searchParams.get("code");
			if (!code) return reply(400, "Missing code", "The authorization server sent no code.");
			reply(200, "Signed in", "You can close this window and return to kiso.");
			settle?.(code);
		});
		server.on("error", () => resolve(null));
		server.listen(port, host, () => {
			resolve({
				waitForCode: () => waited,
				close: () => {
					settle?.(null);
					server.close();
				},
			});
		});
	});
}

export const chatgptFlow: OAuthFlow = {
	providerId: CHATGPT.providerId,
	label: "ChatGPT subscription (Plus/Pro) — the Codex sign-in flow; unofficial for third-party tools",
	async login(interaction: LoginInteraction): Promise<OAuthCredential> {
		const cb = interaction.callback ?? { host: "127.0.0.1", port: 1455 };
		const redirectUri = interaction.callback ? `http://localhost:${cb.port}/auth/callback` : CHATGPT.redirectUri;
		const flow = createAuthorizationFlow(redirectUri);
		const server = await startCallbackServer(flow.state, cb.host, cb.port);
		interaction.notify(`open this URL to sign in:\n  ${flow.url}`);
		let code: string | null = null;
		if (server !== null) {
			interaction.notify(`waiting for the browser to come back to ${redirectUri} … (or paste the redirected URL here)`);
			const pasted = interaction.prompt("").then((line) => {
				const parsed = parseAuthorizationInput(line);
				if (parsed.state !== undefined && parsed.state !== flow.state) throw new Error("ChatGPT sign-in: the pasted state does not match this sign-in");
				return parsed.code ?? null;
			});
			code = await Promise.race([server.waitForCode(), pasted]);
			server.close();
		} else {
			interaction.notify(`port ${cb.port} is busy: after signing in, paste the redirected URL (or the code) here`);
			const parsed = parseAuthorizationInput(await interaction.prompt("redirected URL or code: "));
			if (parsed.state !== undefined && parsed.state !== flow.state) throw new Error("ChatGPT sign-in: the pasted state does not match this sign-in");
			code = parsed.code ?? null;
		}
		if (code === null || code === "") throw new Error("ChatGPT sign-in: no authorization code arrived");
		const tokens = await exchangeCode(code, flow.verifier, redirectUri, interaction.tokenUrl, interaction.signal);
		return credentialFromTokens(tokens);
	},
	async refresh(credential: OAuthCredential, tokenUrl?: string): Promise<OAuthCredential> {
		const tokens = await refreshTokens(credential.refresh, tokenUrl);
		const fresh = credentialFromTokens(tokens);
		const accountId = accountIdOf(tokens.access) ?? credential.accountId;
		return { ...fresh, ...(accountId !== undefined ? { accountId } : {}) };
	},
};
