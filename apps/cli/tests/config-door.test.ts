/**
 * The ./config door: the terminal's profiles, sign-in and session folders as
 * a library, for a host that is not the terminal.
 *
 * SAFETY: every read happens under this test's own temporary KISO_HOME; the
 * real home and the real environment keys are never read.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adapterOptionsFor, applyEffortDeclarations, authForProfile, effortOptions, loadUserConfig, mergeConfigs, projectDirFor, resolveModel, sessionFolders, claimProjectDir } from "../src/config-door.js";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const saved = { home: process.env.KISO_HOME, openai: process.env.OPENAI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY, deepseek: process.env.DEEPSEEK_API_KEY, sessions: process.env.KISO_SESSIONS_DIR };
let home = "";

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "kiso-config-door-")));
	process.env.KISO_HOME = home;
	for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "KISO_SESSIONS_DIR"]) delete process.env[name];
});
afterEach(() => {
	const restore = (name: string, value: string | undefined): void => {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	};
	restore("KISO_HOME", saved.home);
	restore("OPENAI_API_KEY", saved.openai);
	restore("ANTHROPIC_API_KEY", saved.anthropic);
	restore("DEEPSEEK_API_KEY", saved.deepseek);
	restore("KISO_SESSIONS_DIR", saved.sessions);
});

const writeConfig = (config: unknown): void => writeFileSync(join(home, "config.json"), JSON.stringify(config));
const writeAuth = (credentials: unknown): void => writeFileSync(join(home, "auth.json"), JSON.stringify({ version: 1, credentials }));
const PROFILE = { kind: "openai-compat", model: "deepseek-flash", baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY" };

describe("the config door", () => {
	it("the door's import closure never reaches the terminal's state, the TUI or an extension", () => {
		const seen = new Set<string>();
		const packages = new Set<string>();
		const walk = (file: string): void => {
			if (seen.has(file)) return;
			seen.add(file);
			// type-only imports are erased from the build; only value imports load code
			const text = readFileSync(file, "utf8").replace(/(?:import|export)\s+type\s[^;]*?from\s*["'][^"']+["'];?/gs, "");
			for (const m of text.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) {
				const spec = m[1]!;
				if (spec.startsWith(".")) walk(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
				else packages.add(spec);
			}
		};
		walk(join(src, "config-door.ts"));
		const names = [...seen].map((f) => f.slice(src.length + 1)).sort();
		expect(names).not.toContain("state.ts");
		expect(names).toEqual(CLOSURE);
		expect([...packages].filter((p) => p.startsWith("@vincemakes/")).sort()).toEqual(PACKAGES);
	});

	it("a profile and a stored key give the adapter its key with none in the environment", () => {
		writeConfig({ model: "ds", models: { ds: PROFILE } });
		writeAuth({ deepseek: { type: "api-key", key: "sk-stored-0000", savedAt: 1 } });
		const merged = mergeConfigs(loadUserConfig(), null);
		applyEffortDeclarations(merged);
		const resolved = resolveModel(undefined, merged);
		expect(resolved?.name).toBe("ds");
		expect(resolved?.apiKey).toBe("sk-stored-0000");
		const options = adapterOptionsFor(resolved!.profile, { type: "api-key", apiKey: resolved!.apiKey! }, "s1");
		expect(options).toMatchObject({ apiKey: "sk-stored-0000", baseUrl: "https://api.deepseek.com" });
		expect(authForProfile("ds", resolved!.profile)).toMatchObject({ type: "api-key", source: "store" });
	});

	it("an unusable stored credential stays a loud error, never a fall back to the environment", () => {
		process.env.DEEPSEEK_API_KEY = "sk-env-1111";
		writeConfig({ model: "ds", models: { ds: PROFILE } });
		writeFileSync(join(home, "auth.json"), "{ not json");
		expect(() => resolveModel(undefined, mergeConfigs(loadUserConfig(), null))).toThrow(/not valid JSON/);
	});

	it("with nothing stored, the profile's own environment variable applies", () => {
		process.env.DEEPSEEK_API_KEY = "sk-env-1111";
		writeConfig({ model: "ds", models: { ds: PROFILE } });
		const resolved = resolveModel(undefined, mergeConfigs(loadUserConfig(), null));
		expect(authForProfile("ds", resolved!.profile)).toMatchObject({ type: "api-key", apiKey: "sk-env-1111", source: "env" });
	});

	it("lists the project folders and their workspaces, and a second path that encodes alike gets its own folder", () => {
		const a = projectDirFor(home, "/work/a-b");
		claimProjectDir(a, "/work/a-b");
		const b = projectDirFor(home, "/work/a/b");
		expect(b).not.toBe(a);
		claimProjectDir(b, "/work/a/b");
		mkdirSync(join(home, "projects", "_unknown"), { recursive: true });
		const folders = sessionFolders(home);
		expect(folders.filter((f) => f.kind === "project").map((f) => f.workspace).sort()).toEqual(["/work/a-b", "/work/a/b"]);
		expect(folders.some((f) => f.kind === "unknown")).toBe(true);
	});

	it("lists a profile's effort levels, the declared ones for an unknown route, and nothing for an unstated one", () => {
		expect(effortOptions({ model: "no-such-model-anywhere" })).toBeNull();
		writeConfig({ models: { gw: { kind: "openai-compat", model: "gw-model", baseUrl: "https://gw.example/v1", effort: { levels: ["low", "high"], default: "low" } } } });
		const merged = mergeConfigs(loadUserConfig(), null);
		applyEffortDeclarations(merged);
		const gw = merged.models!["gw"]!;
		expect(effortOptions(gw)).toEqual({ levels: ["low", "high"], default: "low" });
	});
});

// measured from the door itself; a new file in the closure is a decision, not an accident
const CLOSURE = [
	"auth/adapter-options.ts",
	"auth/credentials.ts",
	"auth/oauth/index.ts",
	"auth/refresh.ts",
	"auth/token.ts",
	"config-door.ts",
	"config.ts",
	"floor.ts",
	"mode.ts",
	"preferences.ts",
	"projects.ts",
	"protected-writes.ts",
	"remote-boundary.ts",
	"shell-words.ts",
];
const PACKAGES = ["@vincemakes/kiso-runtime", "@vincemakes/kiso-runtime/internal"];
