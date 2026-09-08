import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthError, deleteCredential, getCredential, maskSecret, modifyAuthFile, providerIdOf, readAuthFile, setCredential } from "../src/auth/credentials.js";
import { authForProfile, profileAvailable, unavailableReason, type ModelProfile } from "../src/config.js";

/** The credential store (the sign-in plan, step 1): the file, its mode, the
 *  one write path under a lock, and the resolve rule — a stored credential
 *  owns its provider. */
let dir: string;
let path: string;
let savedHome: string | undefined;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kiso-auth-"));
	path = join(dir, "home", "auth.json");
	savedHome = process.env.KISO_HOME;
	process.env.KISO_HOME = join(dir, "home");
	delete process.env.OPENAI_API_KEY;
	delete process.env.DEEPSEEK_KEY_FOR_TEST;
});
afterEach(() => {
	if (savedHome === undefined) delete process.env.KISO_HOME;
	else process.env.KISO_HOME = savedHome;
});

describe("the file", () => {
	it("is created on the first write with mode 0600, in a home created 0700, and reads back", () => {
		expect(readAuthFile(path)).toEqual({ version: 1, credentials: {} });
		setCredential("deepseek", { type: "api-key", key: "sk-test-1234", savedAt: 1 }, path);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "home")).mode & 0o777).toBe(0o700);
		expect(getCredential("deepseek", path)).toEqual({ type: "api-key", key: "sk-test-1234", savedAt: 1 });
		expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
	});
	it("a malformed or unknown-shaped file is named, never guessed at", () => {
		mkdirSync(join(dir, "home"), { recursive: true });
		writeFileSync(path, "{ nope", "utf8");
		expect(() => readAuthFile(path)).toThrow(AuthError);
		writeFileSync(path, JSON.stringify({ version: 2, credentials: {} }), "utf8");
		expect(() => readAuthFile(path)).toThrow(/unknown shape/);
	});
	it("delete reports whether anything was there; the file survives empty", () => {
		setCredential("openai", { type: "api-key", key: "k", savedAt: 1 }, path);
		expect(deleteCredential("openai", path)).toBe(true);
		expect(deleteCredential("openai", path)).toBe(false);
		expect(readAuthFile(path).credentials).toEqual({});
	});
});

describe("the one write path", () => {
	it("serializes writers across PROCESSES: twenty children each add their own provider; nothing is lost", () => {
		mkdirSync(join(dir, "home"), { recursive: true });
		const script = join(dir, "writer.mjs");
		writeFileSync(
			script,
			`import { setCredential } from ${JSON.stringify(new URL("../dist/auth/credentials.js", import.meta.url).href)};
const [id, p] = process.argv.slice(2);
setCredential(id, { type: "api-key", key: "k-" + id, savedAt: 1 }, p);`,
			"utf8",
		);
		const N = 20;
		const procs = Array.from({ length: N }, (_, i) => execFileSync(process.execPath, [script, `p${i}`, path], { encoding: "utf8" }));
		expect(procs).toHaveLength(N);
		const file = readAuthFile(path);
		expect(Object.keys(file.credentials).sort()).toEqual(Array.from({ length: N }, (_, i) => `p${i}`).sort());
	});
	it("a stale lock (an earlier process that died) is reclaimed by age", () => {
		mkdirSync(join(dir, "home"), { recursive: true });
		const lock = `${path}.lock`;
		mkdirSync(lock);
		const old = new Date(Date.now() - 60_000);
		execFileSync("touch", ["-t", `${old.getFullYear()}${String(old.getMonth() + 1).padStart(2, "0")}${String(old.getDate()).padStart(2, "0")}${String(old.getHours()).padStart(2, "0")}${String(old.getMinutes()).padStart(2, "0")}`, lock]);
		setCredential("zai", { type: "api-key", key: "k", savedAt: 1 }, path);
		expect(existsSync(lock)).toBe(false);
		expect(getCredential("zai", path)?.type).toBe("api-key");
	});
	it("modifyAuthFile writes exactly what the transform returns", () => {
		modifyAuthFile(() => ({ version: 1, credentials: { anthropic: { type: "oauth", access: "a", refresh: "r", expires: 5, savedAt: 1 } } }), path);
		expect(getCredential("anthropic", path)?.type).toBe("oauth");
	});
});

describe("the resolve rule", () => {
	const deepseek: ModelProfile = { kind: "openai-compat", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", apiKeyEnv: "DEEPSEEK_KEY_FOR_TEST" };
	const local: ModelProfile = { kind: "openai-compat", baseUrl: "http://localhost:11434", model: "x" };
	const custom: ModelProfile = { kind: "openai-compat", baseUrl: "http://localhost:11434", model: "x", apiKeyEnv: "CUSTOM_KEY" };
	it("provider identity: anthropic; openai by default; a known origin; null for an unknown one", () => {
		expect(providerIdOf("anthropic")).toBe("anthropic");
		expect(providerIdOf("openai-compat")).toBe("openai");
		expect(providerIdOf("openai-compat", "https://api.deepseek.com/v1")).toBe("deepseek");
		expect(providerIdOf("openai-compat", "https://open.bigmodel.cn/api")).toBe("zai");
		expect(providerIdOf("openai-compat", "http://localhost:11434")).toBeNull();
		expect(providerIdOf("openai-compat", "not a url")).toBeNull();
	});
	// OR-1: the Responses dialect is served by exactly two identities, so
	// it has no `custom` bucket — an unrecognized origin is still OpenAI's
	// API shape behind a proxy, and OpenAI's credential pays for it.
	it("provider identity: the Responses dialect is chatgpt at that origin and openai everywhere else", () => {
		expect(providerIdOf("openai-responses")).toBe("openai");
		expect(providerIdOf("openai-responses", "https://chatgpt.com/backend-api")).toBe("chatgpt");
		expect(providerIdOf("openai-responses", "https://api.openai.com/v1")).toBe("openai");
		expect(providerIdOf("openai-responses", "http://127.0.0.1:8080")).toBe("openai");
		expect(providerIdOf("openai-responses", "not a url")).toBe("openai");
	});
	it("OR-1: a stored OAuth sign-in is USABLE by the Responses kind — the same credential that is a refusal for a key-only kind", () => {
		const subscription: ModelProfile = { kind: "openai-responses", baseUrl: "https://chatgpt.com/backend-api", model: "gpt-5.5" };
		setCredential("chatgpt", { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 1e6, accountId: "acct", savedAt: 1 }, path);
		expect(authForProfile("sub", subscription)).toEqual({ type: "oauth", providerId: "chatgpt" });
		// …and it is AVAILABLE: the key-only resolver would have called a
		// working sign-in broken, which is the bug this shape prevents.
		expect(profileAvailable(subscription)).toBe(true);
		expect(unavailableReason("sub", subscription)).toBe("");
	});
	it("nothing stored: the env var applies; unset → unavailable, naming both login and the var", () => {
		expect(profileAvailable(deepseek)).toBe(false);
		expect(unavailableReason("ds", deepseek)).toContain("run `kiso login deepseek` or set the env var DEEPSEEK_KEY_FOR_TEST");
		process.env.DEEPSEEK_KEY_FOR_TEST = "from-env";
		expect(authForProfile("ds", deepseek)).toEqual({ type: "api-key", apiKey: "from-env", source: "env" });
	});
	it("a stored key owns the provider — it wins over the env var", () => {
		process.env.DEEPSEEK_KEY_FOR_TEST = "from-env";
		setCredential("deepseek", { type: "api-key", key: "from-store", savedAt: 1 }, path);
		expect(authForProfile("ds", deepseek)).toEqual({ type: "api-key", apiKey: "from-store", source: "store" });
	});
	it("a stored OAuth credential where the adapter needs a key is a NAMED error, never a silent fall back to env", () => {
		process.env.DEEPSEEK_KEY_FOR_TEST = "from-env";
		setCredential("deepseek", { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 1e6, savedAt: 1 }, path);
		expect(() => authForProfile("ds", deepseek)).toThrow(/signed in to deepseek with OAuth.*kiso logout deepseek/);
		expect(profileAvailable(deepseek)).toBe(false);
	});
	it("a keyless profile is an unauthenticated endpoint; a custom origin stays on env", () => {
		expect(authForProfile("local", local)).toEqual({ type: "api-key", apiKey: "none", source: "none" });
		expect(unavailableReason("c", custom)).toContain("set the env var CUSTOM_KEY");
		expect(unavailableReason("c", custom)).not.toContain("kiso login");
	});
	it("a secret is only ever rendered masked", () => {
		expect(maskSecret("sk-abcdefgh1234")).toBe("••••1234");
		expect(maskSecret("abc")).toBe("••••");
	});
});
