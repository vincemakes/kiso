/**
 * kiso-secrets: the deny list and the shape-only content patterns. Every
 * positive is SYNTHESIZED at run time (never a real secret, and never a
 * literal a secret scanner would flag in this file); the negatives are the
 * shapes that must never match.
 */
import { describe, expect, it } from "vitest";
import { findSecret, isCredentialName, isCredentialPath, isSecretLocation, strippedShellEnv } from "../src/index.js";

const rep = (c: string, n: number) => c.repeat(n);
const mix = (n: number) => Array.from({ length: n }, (_, i) => "aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z"[i % 31]).join("");

describe("findSecret: synthesized positives, one per kind", () => {
	const cases: [string, string][] = [
		["pem-private-key", `-----BEGIN ${"RSA"} PRIVATE KEY-----\nMIIE...`],
		["pem-private-key", `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----`],
		["pem-private-key", `-----BEGIN ${""}PRIVATE KEY-----`],
		["aws-access-key", `key ${"AK" + "IA"}${rep("Q", 8)}${rep("7", 8)} here`],
		["github-token", `${"gh" + "p_"}${mix(36)}`],
		["github-token", `${"github" + "_pat_"}${mix(82)}`],
		["slack-token", `${"xo" + "xb"}-${"1234567890"}-${"0987654321"}-${mix(24)}`],
		["provider-key", `ANTHROPIC_API_KEY=${"sk-" + "ant-"}api03-${mix(40)}`],
		["provider-key", `${"sk-" + "proj-"}${mix(48)}`],
		["provider-key", `deepseek: ${"sk" + "-"}${mix(32)}`],
		["google-api-key", `${"AI" + "za"}${mix(35)}`],
		["jwt", `Bearer ${"ey" + "J"}${mix(20)}.${"ey" + "J"}${mix(30)}.${mix(43)}`],
		["url-credentials", `postgres://admin:${mix(12)}@db.internal:5432/app`],
		["assignment", `password = "${mix(14)}"`],
		["assignment", `api_key: ${mix(20)}`],
	];
	for (const [kind, text] of cases) it(`${kind}: ${text.slice(0, 24)}…`, () => expect(findSecret(text)?.kind).toBe(kind));
	it("returns the FIRST secret by position, with its span", () => {
		const text = `x ${"AK" + "IA"}${rep("Z", 16)} y ${"sk-" + "ant-"}${mix(30)}`;
		const m = findSecret(text);
		expect(m?.kind).toBe("aws-access-key");
		expect(text.slice(m!.start, m!.end)).toBe(`${"AK" + "IA"}${rep("Z", 16)}`);
	});
});

describe("findSecret: the negative corpus never matches", () => {
	const negatives = [
		"commit 2201aed1f3c4b5a6978877665544332211009988",
		"id 3f1c8a2e-9b4d-4e6f-8a1b-2c3d4e5f6a7b",
		"const blob = 'aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQgZW5jb2RlZCBkYXRh';",
		"API_KEY=${API_KEY}",
		"password: <your-password>",
		"OPENAI_API_KEY=sk-...",
		"token: string;",
		"const password = getPassword();",
		"secret = process.env.SECRET",
		"Anthropic keys start with sk-ant- and OpenAI project keys with sk-proj-.",
		"postgres://user:${DB_PASSWORD}@localhost/app",
		"https://github.com/vincemakes/kiso.git",
		"api_key: changeme",
		"password = 'xxxxxxxxxx'",
		"-----BEGIN PUBLIC KEY-----",
		"-----BEGIN CERTIFICATE-----",
	];
	for (const n of negatives) it(n.slice(0, 40), () => expect(findSecret(n)).toBeNull());
});

describe("isSecretLocation (#31's deny list, for the owner to confirm: D12)", () => {
	const ctx = { home: "/Users/p", kisoHome: "/Users/p/.kiso" };
	it("the SSH directory, keychains and GnuPG, whole", () => {
		for (const p of ["/Users/p/.ssh", "/Users/p/.ssh/id_ed25519.pub", "/Users/p/.ssh/config", "/Users/p/.gnupg/pubring.kbx", "/Users/p/Library/Keychains/login.keychain-db", "/Users/p/.local/share/keyrings/login.keyring"]) expect(isSecretLocation(p, ctx), p).toBe(true);
	});
	it("the credential-file set, anywhere", () => {
		for (const p of ["/work/app/.env", "/work/app/.env.local", "/work/.npmrc", "/Users/p/.aws/credentials", "/Users/p/.kube/config", "/tmp/server.pem"]) expect(isSecretLocation(p, ctx), p).toBe(true);
	});
	it("kiso's own credentials", () => {
		expect(isSecretLocation("/Users/p/.kiso/auth.json", ctx)).toBe(true);
		expect(isSecretLocation("/Users/p/.kiso/profiles/credentials.env", ctx)).toBe(true);
		expect(isSecretLocation("/Users/p/.kiso/sessions/s1.jsonl", ctx)).toBe(false);
	});
	it("browser profile roots, whole (cookies, Login Data, history), on macOS, Linux and Windows", () => {
		const roots = [
			"/Users/p/Library/Application Support/Google/Chrome/Default/Cookies",
			"/Users/p/Library/Application Support/Chromium/Default/Login Data",
			"/Users/p/Library/Application Support/Microsoft Edge/Profile 1/Login Data",
			"/Users/p/Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies",
			"/Users/p/Library/Application Support/Firefox/Profiles/x.default/cookies.sqlite",
			"/Users/p/Library/Cookies/Cookies.binarycookies",
			"/Users/p/Library/Safari/History.db",
			"/Users/p/.config/google-chrome/Default/Cookies",
			"/Users/p/.config/chromium/Default/Login Data",
			"/Users/p/.config/microsoft-edge/Default/Cookies",
			"/Users/p/.config/BraveSoftware/Brave-Browser/Default/Login Data",
			"/Users/p/.mozilla/firefox/x.default/logins.json",
		];
		for (const p of roots) expect(isSecretLocation(p, ctx), p).toBe(true);
		const win = { home: "C:\\Users\\p", kisoHome: "C:\\Users\\p\\.kiso", separator: "\\" };
		for (const p of ["C:\\Users\\p\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies", "C:\\Users\\p\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Login Data", "C:\\Users\\p\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\x\\key4.db"]) expect(isSecretLocation(p, win), p).toBe(true);
	});
	it("known password-manager stores, by name only", () => {
		for (const p of [
			"/Users/p/Library/Group Containers/2BUA8C4S2C.com.1password/Library/Application Support/1Password/Data/1password.sqlite",
			"/Users/p/.config/1Password/settings.json",
			"/Users/p/Library/Application Support/Bitwarden/data.json",
			"/Users/p/.config/Bitwarden/data.json",
			"/Users/p/.password-store/email/work.gpg",
			"/Users/p/.lpass/session",
			"/Users/p/.config/keepassxc/keepassxc.ini",
			"/work/vault/Passwords.kdbx",
		]) expect(isSecretLocation(p, ctx), p).toBe(true);
	});
	it("no fuzzy matching: a name that only resembles a store is not one", () => {
		for (const p of ["/Users/p/projects/chrome-extension/src/cookies.ts", "/Users/p/.config/bitwarden-cli-notes.md", "/Users/p/Library/Application Support/Google/Drive/config.json", "/work/firefox-docs/Profiles.md", "/work/app/password-store.ts"]) expect(isSecretLocation(p, ctx), p).toBe(false);
	});
	it("ordinary files are not secret locations; templates stay readable", () => {
		for (const p of ["/work/app/src/index.ts", "/work/app/.env.example", "/work/app/.environment", "/Users/p/.sshrc", "/Users/p/Documents/notes.md"]) expect(isSecretLocation(p, ctx), p).toBe(false);
	});
	it("case-folded like a case-insensitive disk, and the host's separator", () => {
		expect(isSecretLocation("/Users/P/.SSH/known_hosts", ctx)).toBe(true);
		expect(isSecretLocation("C:\\Users\\p\\.ssh\\id_rsa", { home: "C:\\Users\\p", kisoHome: "C:\\Users\\p\\.kiso", separator: "\\" })).toBe(true);
	});
});

describe("the moved rules are unchanged", () => {
	it("credential names and paths", () => {
		expect(isCredentialName(".env")).toBe(true);
		expect(isCredentialName(".env.example")).toBe(false);
		expect(isCredentialName("id_rsa.pub")).toBe(false);
		expect(isCredentialPath("/home/u/.AWS/Credentials")).toBe(true);
		expect(isCredentialPath("C:\\u\\.aws\\credentials", "\\")).toBe(true);
	});
	it("the child-environment strip", () => {
		expect(strippedShellEnv({ OPENAI_API_KEY: "a", FOO_AUTH_TOKEN: "b", MINE: "c", PATH: "/bin" }, ["MINE"])).toEqual({ PATH: "/bin" });
	});
});
