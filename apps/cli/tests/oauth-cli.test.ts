/**
 * `kiso login chatgpt` end to end on the built CLI: a fake token endpoint,
 * a random callback port, a fake browser that hits the callback; the
 * credential lands in auth.json with the account id; `kiso auth` lists it as
 * oauth with its expiry. No vendor is contacted.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");
const jwt = (payload: Record<string, unknown>): string => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

describe("kiso login chatgpt (built CLI, local doubles)", () => {
	it("stores an oauth credential with the account id; auth lists it; logout removes it", async () => {
		const { env, dirs } = isolatedEnv();
		const token = createServer((req, res) => {
			let body = "";
			req.on("data", (d) => (body += d));
			req.on("end", () => {
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ access_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-e2e" } }), refresh_token: "r1", expires_in: 3600 }));
			});
		});
		const tokenUrl: string = await new Promise((resolve) => token.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(token.address() as { port: number }).port}/oauth/token`)));
		const cbPort: number = await new Promise((resolve) => {
			const s = createServer();
			s.listen(0, "127.0.0.1", () => {
				const p = (s.address() as { port: number }).port;
				s.close(() => resolve(p));
			});
		});
		const child = spawn(process.execPath, [CLI, "login", "chatgpt"], { env: { ...env, KISO_OAUTH_TOKEN_URL: tokenUrl, KISO_OAUTH_CALLBACK_PORT: String(cbPort) }, stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => {
			out += d;
			const m = /open this URL to sign in:\s+(\S+)/.exec(out);
			if (m && !out.includes("__browser_done__")) {
				out += "__browser_done__";
				const state = new URL(m[1]!).searchParams.get("state");
				void fetch(`http://127.0.0.1:${cbPort}/auth/callback?code=e2e-code&state=${state}`);
			}
		});
		child.stderr.on("data", (d) => (err += d));
		const status: number | null = await new Promise((resolve) => child.on("exit", (code) => resolve(code)));
		token.close();
		expect(status, err).toBe(0);
		expect(out).toContain("signed in to chatgpt");
		expect(out).toContain("acct-e2e");
		const file = JSON.parse(readFileSync(join(dirs.home, "auth.json"), "utf8"));
		expect(file.credentials.chatgpt).toMatchObject({ type: "oauth", accountId: "acct-e2e", refresh: "r1" });
		const auth = runCli(["auth"], env);
		expect(auth.stdout).toContain("chatgpt");
		expect(auth.stdout).toContain("oauth");
		expect(auth.stdout).not.toContain(file.credentials.chatgpt.access);
		expect(runCli(["logout", "chatgpt"], env).stdout).toContain("signed out of chatgpt");
	}, 60_000);
});
