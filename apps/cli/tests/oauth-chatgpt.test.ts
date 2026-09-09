/**
 * The ChatGPT subscription sign-in flow, proven against LOCAL doubles: a fake
 * token endpoint (issues a JWT with the account claim), a fake browser (a
 * fetch of the callback URL), a random callback port. No vendor is contacted.
 * Also the refresh rule (`ensureFresh`) with a fake flow.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generatePkce, randomState } from "../src/auth/oauth/pkce.js";
import { CHATGPT, accountIdOf, chatgptFlow, createAuthorizationFlow, credentialFromTokens, decodeJwtPayload, parseAuthorizationInput, startCallbackServer } from "../src/auth/oauth/chatgpt.js";
import { AuthError, getCredential, setCredential } from "../src/auth/credentials.js";
import { FRESH_WINDOW_MS, ensureFresh } from "../src/auth/refresh.js";
import { createHash } from "node:crypto";

const jwt = (payload: Record<string, unknown>): string => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
const claimed = (id: string, extra: Record<string, unknown> = {}): string => jwt({ [CHATGPT.jwtClaimPath]: { chatgpt_account_id: id }, ...extra });

async function freePort(): Promise<number> {
	return await new Promise((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const port = (s.address() as { port: number }).port;
			s.close(() => resolve(port));
		});
	});
}

/** A fake token endpoint: records the last request body; answers with a
 *  claimed JWT (exchange) or a rotated pair (refresh), or an error on cue. */
function fakeTokenEndpoint(): Promise<{ url: string; last: () => URLSearchParams | null; fail: (status: number | null) => void; close: () => void; server: Server }> {
	let last: URLSearchParams | null = null;
	let failWith: number | null = null;
	let n = 0;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (d) => (body += d));
		req.on("end", () => {
			last = new URLSearchParams(body);
			if (failWith !== null) {
				res.statusCode = failWith;
				res.end("nope");
				return;
			}
			n += 1;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ access_token: claimed("acct-123", { n }), refresh_token: `refresh-${n}`, expires_in: 3600 }));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			resolve({ url: `http://127.0.0.1:${port}/oauth/token`, last: () => last, fail: (s) => (failWith = s), close: () => server.close(), server });
		});
	});
}

describe("PKCE and the authorize URL", () => {
	it("verifier and challenge are base64url without padding; the challenge is the verifier's SHA-256", () => {
		const { verifier, challenge } = generatePkce();
		expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
		expect(randomState()).toMatch(/^[0-9a-f]{32}$/);
	});
	it("the authorize URL carries the client id, S256, the state, the scope and kiso as the originator", () => {
		const flow = createAuthorizationFlow();
		const url = new URL(flow.url);
		expect(`${url.origin}${url.pathname}`).toBe(CHATGPT.authorizeUrl);
		expect(url.searchParams.get("client_id")).toBe(CHATGPT.clientId);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("state")).toBe(flow.state);
		expect(url.searchParams.get("redirect_uri")).toBe(CHATGPT.redirectUri);
		expect(url.searchParams.get("scope")).toBe(CHATGPT.scope);
		expect(url.searchParams.get("originator")).toBe("kiso");
		expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
	});
	it("a pasted redirect URL, a code#state pair, a query string and a bare code all parse", () => {
		expect(parseAuthorizationInput("http://localhost:1455/auth/callback?code=C&state=S")).toEqual({ code: "C", state: "S" });
		expect(parseAuthorizationInput("C#S")).toEqual({ code: "C", state: "S" });
		expect(parseAuthorizationInput("code=C&state=S")).toEqual({ code: "C", state: "S" });
		expect(parseAuthorizationInput("  C  ")).toEqual({ code: "C" });
		expect(parseAuthorizationInput("")).toEqual({});
	});
	it("the account id is the JWT claim; a token without it is refused", () => {
		expect(accountIdOf(claimed("acct-9"))).toBe("acct-9");
		expect(accountIdOf(jwt({ sub: "x" }))).toBeNull();
		expect(accountIdOf("not.a.jwt.really")).toBeNull();
		expect(decodeJwtPayload("garbage")).toBeNull();
		expect(() => credentialFromTokens({ access: jwt({}), refresh: "r", expires: 1 })).toThrow(/chatgpt_account_id/);
	});
});

describe("the callback server", () => {
	it("a wrong state is 400, a wrong path 404, the right state delivers the code once", async () => {
		const port = await freePort();
		const state = randomState();
		const server = await startCallbackServer(state, "127.0.0.1", port);
		expect(server).not.toBeNull();
		const bad = await fetch(`http://127.0.0.1:${port}/auth/callback?code=X&state=wrong`);
		expect(bad.status).toBe(400);
		const lost = await fetch(`http://127.0.0.1:${port}/elsewhere`);
		expect(lost.status).toBe(404);
		const ok = await fetch(`http://127.0.0.1:${port}/auth/callback?code=the-code&state=${state}`);
		expect(ok.status).toBe(200);
		expect(await server!.waitForCode()).toBe("the-code");
		server!.close();
	});
	it("a port that cannot be bound yields null (the paste path takes over)", async () => {
		const port = await freePort();
		const first = await startCallbackServer("s", "127.0.0.1", port);
		const second = await startCallbackServer("s", "127.0.0.1", port);
		expect(first).not.toBeNull();
		expect(second).toBeNull();
		first!.close();
	});
});

describe("the whole flow against local doubles", () => {
	let tokens: Awaited<ReturnType<typeof fakeTokenEndpoint>>;
	beforeAll(async () => {
		tokens = await fakeTokenEndpoint();
	});
	afterAll(() => tokens.close());

	it("login: the browser comes back with the code, the code is exchanged with the PKCE verifier, the credential carries the account id", async () => {
		const port = await freePort();
		const lines: string[] = [];
		// OR-4 (owner, 2026-09-09): the flow hands the authorize URL to the
		// interaction's `open` — the CLI opens the browser on a TTY; here the
		// stub records it, and the URL must be the one the notify line printed.
		const opened: string[] = [];
		const cred = await chatgptFlow.login({
			notify: (l) => {
				lines.push(l);
				const m = /open this URL to sign in:\n\s+(\S+)/.exec(l);
				if (m) {
					const state = new URL(m[1]!).searchParams.get("state");
					setTimeout(() => void fetch(`http://127.0.0.1:${port}/auth/callback?code=from-browser&state=${state}`), 50);
				}
			},
			open: (url) => opened.push(url),
			prompt: () => new Promise(() => {}), // nobody pastes
			callback: { host: "127.0.0.1", port },
			tokenUrl: tokens.url,
		});
		expect(cred.type).toBe("oauth");
		const printed = /open this URL to sign in:\n\s+(\S+)/.exec(lines.join("\n"))?.[1];
		expect(opened).toEqual([printed]); // opened exactly once, with the printed URL
		expect(lines.some((l) => l.includes("opened in your browser"))).toBe(true);
		expect(cred.accountId).toBe("acct-123");
		expect(cred.refresh).toBe("refresh-1");
		expect(cred.expires).toBeGreaterThan(Date.now() + 3500_000);
		const body = tokens.last()!;
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("code")).toBe("from-browser");
		expect(body.get("client_id")).toBe(CHATGPT.clientId);
		expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(body.get("redirect_uri")).toBe(`http://localhost:${port}/auth/callback`);
	});

	it("login: a pasted redirect URL works when the browser never comes back; a pasted state that does not match is refused", async () => {
		const port = await freePort();
		let url = "";
		const cred = await chatgptFlow.login({
			notify: (l) => {
				const m = /open this URL to sign in:\n\s+(\S+)/.exec(l);
				if (m) url = m[1]!;
			},
			prompt: async () => `http://localhost:${port}/auth/callback?code=pasted&state=${new URL(url).searchParams.get("state")}`,
			callback: { host: "127.0.0.1", port },
			tokenUrl: tokens.url,
		});
		expect(cred.accountId).toBe("acct-123");
		expect(tokens.last()!.get("code")).toBe("pasted");
		const port2 = await freePort();
		await expect(
			chatgptFlow.login({ notify: () => {}, prompt: async () => "http://localhost/auth/callback?code=x&state=wrong", callback: { host: "127.0.0.1", port: port2 }, tokenUrl: tokens.url }),
		).rejects.toThrow(/state does not match/);
	});

	it("refresh: the refresh token is sent, the pair rotates, a failed refresh is a named error", async () => {
		const before = credentialFromTokens({ access: claimed("acct-123"), refresh: "old-refresh", expires: 1 });
		const after = await chatgptFlow.refresh(before, tokens.url);
		expect(tokens.last()!.get("grant_type")).toBe("refresh_token");
		expect(tokens.last()!.get("refresh_token")).toBe("old-refresh");
		expect(after.refresh).not.toBe("old-refresh");
		expect(after.accountId).toBe("acct-123");
		tokens.fail(401);
		await expect(chatgptFlow.refresh(before, tokens.url)).rejects.toThrow(/token refresh failed \(401\)/);
		tokens.fail(null);
	});
});

describe("ensureFresh — when a refresh happens", () => {
	let path: string;
	let savedHome: string | undefined;
	beforeEach(() => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-fresh-"));
		path = join(dir, "home", "auth.json");
		savedHome = process.env.KISO_HOME;
		process.env.KISO_HOME = join(dir, "home");
	});
	const fakeFlow = (impl: () => Promise<{ access: string; refresh: string; expires: number }>) => ({
		providerId: "chatgpt",
		label: "fake",
		login: async () => {
			throw new Error("not here");
		},
		refresh: async () => ({ type: "oauth" as const, ...(await impl()), accountId: "a", savedAt: Date.now() }),
	});
	it("a credential outside the window is returned untouched; inside it is refreshed and written; a key is never refreshed", async () => {
		const now = 1_000_000_000_000;
		setCredential("chatgpt", { type: "oauth", access: "A", refresh: "R", expires: now + FRESH_WINDOW_MS + 1000, accountId: "a", savedAt: 1 }, path);
		let calls = 0;
		const flow = fakeFlow(async () => {
			calls += 1;
			return { access: "A2", refresh: "R2", expires: now + 3_600_000 };
		});
		expect((await ensureFresh("chatgpt", flow, path, now)) as { access?: string }).toMatchObject({ access: "A" });
		expect(calls).toBe(0);
		setCredential("chatgpt", { type: "oauth", access: "A", refresh: "R", expires: now + 60_000, accountId: "a", savedAt: 1 }, path);
		const fresh = (await ensureFresh("chatgpt", flow, path, now)) as { access?: string; refresh?: string };
		expect(calls).toBe(1);
		expect(fresh.access).toBe("A2");
		expect((getCredential("chatgpt", path) as { refresh?: string }).refresh).toBe("R2");
		setCredential("deepseek", { type: "api-key", key: "k", savedAt: 1 }, path);
		expect(await ensureFresh("deepseek", flow, path, now)).toMatchObject({ type: "api-key" });
		expect(calls).toBe(1);
	});
	it("a failed refresh is a named error that points at login; nothing stored is a named error too", async () => {
		const now = 1_000_000_000_000;
		setCredential("chatgpt", { type: "oauth", access: "A", refresh: "R", expires: now + 1000, accountId: "a", savedAt: 1 }, path);
		const flow = fakeFlow(async () => {
			throw new Error("401 nope");
		});
		await expect(ensureFresh("chatgpt", flow, path, now)).rejects.toThrow(/signed out of chatgpt.*kiso login chatgpt/);
		expect((getCredential("chatgpt", path) as { access?: string }).access).toBe("A"); // the old credential stays until a login replaces it
		await expect(ensureFresh("nothing", flow, path, now)).rejects.toThrow(AuthError);
	});
	it("a concurrent refresh that already wrote a fresher token wins", async () => {
		const now = 1_000_000_000_000;
		setCredential("chatgpt", { type: "oauth", access: "A", refresh: "R", expires: now + 1000, accountId: "a", savedAt: 1 }, path);
		const flow = fakeFlow(async () => {
			// another process refreshed while we were on the wire
			setCredential("chatgpt", { type: "oauth", access: "THEIRS", refresh: "RT", expires: now + 9_000_000, accountId: "a", savedAt: 2 }, path);
			return { access: "MINE", refresh: "RM", expires: now + 3_600_000 };
		});
		const result = (await ensureFresh("chatgpt", flow, path, now)) as { access?: string };
		expect(result.access).toBe("THEIRS");
	});
	afterAll(() => {
		if (savedHome === undefined) delete process.env.KISO_HOME;
		else process.env.KISO_HOME = savedHome;
	});
});
