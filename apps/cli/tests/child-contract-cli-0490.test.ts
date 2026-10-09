/**
 * 0.49.0 C through the CLI.
 *
 * C1: `subagents.model` is one user-level key naming a configured profile
 * (a project may not set it); the conversation's binding is the session's
 * own record, with a unique (model, baseUrl) match as the fallback — never
 * a guess; a child handed the conversation's effort starts at it, and
 * only a child reads that hand-off.
 * I6: a child's result record says how it ended — its error included —
 * so the parent never reads its log or counts its runs to learn it.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readProfile } from "@vincemakes/kiso-runtime/internal";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { ConfigError, mergeConfigs, parseConfig } from "../src/config.js";
import { bindingFor, profileByIdentity, setConfigModels, setLiveSession } from "../src/state.js";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");
const HIGH = { thinking: "default", effort: "high" } as const;
const MODELS = {
	sol: { kind: "openai-responses", model: "gpt-x", baseUrl: "https://a.example/v1" },
	co: { kind: "openai-compat", model: "flash", baseUrl: "https://b.example/v1" },
	co2: { kind: "openai-compat", model: "flash", baseUrl: "https://b.example/v1" },
} as const;

afterEach(() => setConfigModels({}));

describe("0.49.0 C1 — subagents.model", () => {
	it("a user config names one of its profiles; the merge carries it", () => {
		const user = parseConfig(JSON.stringify({ models: { sol: MODELS.sol, co: MODELS.co }, subagents: { model: "co" } }), "~/.kiso/config.json");
		expect(user.subagents).toEqual({ model: "co" });
		expect(mergeConfigs(user, null).subagents).toEqual({ model: "co" });
	});

	it("a name that is not a profile is refused at load, naming the profiles there are", () => {
		expect(() => parseConfig(JSON.stringify({ models: { sol: MODELS.sol }, subagents: { model: "ds" } }), "~/.kiso/config.json")).toThrow(/subagents\.model — "ds" names no profile in models \(configured: sol\)/);
		expect(() => parseConfig(JSON.stringify({ subagents: { model: "" } }), "x")).toThrow(ConfigError);
		expect(() => parseConfig(JSON.stringify({ subagents: "co" }), "x")).toThrow(/subagents — expected an object/);
	});

	it("a project may not choose the model your children run on", () => {
		expect(() => parseConfig(JSON.stringify({ subagents: { model: "co" } }), "<cwd>/.kiso/config.json")).toThrow(/subagents — belongs in the USER config/);
	});
});

describe("0.49.0 C1 — the conversation's binding", () => {
	it("is the session's own profile and effort, read live — not the display mark /reload and /resume clear", () => {
		setConfigModels(MODELS);
		setLiveSession({ id: "s1", model: "gpt-x", baseUrl: "https://a.example/v1", profileName: "sol", reasoning: HIGH });
		expect(bindingFor("s1")).toEqual({ profile: "sol", model: "gpt-x", reasoning: HIGH });
		expect(bindingFor("s-unknown")).toBeNull();
		expect(bindingFor(undefined)).toBeNull();
	});

	it("a session with no recorded profile is matched by its model and endpoint — when exactly one profile has them", () => {
		setConfigModels(MODELS);
		setLiveSession({ id: "s2", model: "gpt-x", baseUrl: "https://a.example/v1", profileName: null, reasoning: HIGH });
		expect(bindingFor("s2")?.profile).toBe("sol");
		expect(profileByIdentity("flash", "https://b.example/v1"), "two profiles fit: no guess").toBeNull();
		expect(profileByIdentity("gpt-x", "https://other.example/v1")).toBeNull();
		setLiveSession({ id: "s3", model: "flash", baseUrl: "https://b.example/v1", profileName: null, reasoning: HIGH });
		expect(bindingFor("s3")?.profile).toBeNull();
	});

	it("a recorded profile that is no longer configured is not handed on", () => {
		setConfigModels({ co: MODELS.co });
		setLiveSession({ id: "s4", model: "gpt-x", baseUrl: "https://a.example/v1", profileName: "sol", reasoning: HIGH });
		expect(bindingFor("s4")?.profile).toBeNull();
	});
});

function runChild(script: unknown[], env: Record<string, string>): { status: number | null; home: string; result: string } {
	const { env: base, dirs } = isolatedEnv({ KISO_MODE: "bypass" });
	const work = mkdtempSync(join(tmpdir(), "kiso-c0490-ws-"));
	writeFileSync(join(dirs.home, "faux.json"), JSON.stringify(script));
	writeFileSync(join(dirs.home, "task.txt"), "look\n");
	const result = join(work, "result.md");
	const r = spawnSync("node", [CLI, "chat", "sub-r1", "--task-file", join(dirs.home, "task.txt"), "--result-file", result], {
		env: { ...base, KISO_FAUX_SCRIPT: join(dirs.home, "faux.json"), ...env },
		cwd: work,
		encoding: "utf8",
		timeout: 60_000,
	});
	return { status: r.status, home: dirs.home, result };
}

const END = { events: [{ type: "text_delta", text: "done" }, { type: "stop", reason: "end_turn" }] };

describe("0.49.0 C1 — a child handed the conversation's effort", () => {
	it("starts at it", () => {
		const { home } = runChild([END], { KISO_SUBAGENT_DEPTH: "1", KISO_CHILD_REASONING: JSON.stringify(HIGH) });
		const p = readProfile(join(home, "sessions"), "sub-r1");
		expect(p.kind).toBe("ok");
		expect(p.kind === "ok" ? p.profile.reasoning : null).toEqual(HIGH);
	}, 60_000);

	it("a top-level kiso ignores a stray hand-off", () => {
		const { home } = runChild([END], { KISO_CHILD_REASONING: JSON.stringify(HIGH) });
		const p = readProfile(join(home, "sessions"), "sub-r1");
		expect(p.kind === "ok" ? p.profile.reasoning.effort : null).not.toBe("high");
	}, 60_000);
});

describe("0.49.0 I6 — a failed child's record carries its error", () => {
	it("the provider's refusal is in result.json, committed after result.md", async () => {
		// a real provider path (faux mode turns any error into a harness
		// exception): a loopback that refuses every request with a 402
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			req.resume();
			res.writeHead(402, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "Insufficient Balance", type: "unknown_error" } }));
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as { port: number }).port;
		try {
			const { env, dirs } = isolatedEnv({ KISO_MODE: "bypass", C1_KEY: "k-test", KISO_MAX_RETRIES: "0", KISO_SUBAGENT_DEPTH: "1" });
			writeFileSync(join(dirs.home, "config.json"), JSON.stringify({ models: { live: { kind: "openai-compat", model: "m-live", apiKeyEnv: "C1_KEY", baseUrl: `http://127.0.0.1:${port}/v1` } } }));
			writeFileSync(join(dirs.home, "task.txt"), "look\n");
			const work = mkdtempSync(join(tmpdir(), "kiso-c0490-ws-"));
			const result = join(work, "result.md");
			const child = spawn(process.execPath, [CLI, "--model", "live", "chat", "sub-r2", "--task-file", join(dirs.home, "task.txt"), "--result-file", result], { env, cwd: work, stdio: "ignore" });
			const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
			const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
			clearTimeout(timer);
			expect(code).toBe(1);
			const record = JSON.parse(readFileSync(join(result, "..", "result.json"), "utf8")) as Record<string, unknown>;
			expect(record).toMatchObject({ outcome: "failed", endedBy: "error", model: "m-live", profile: "live" });
			expect(String(record.error)).toMatch(/402/);
			expect(String(record.error)).toMatch(/Insufficient Balance/);
			expect(readFileSync(result, "utf8")).toBe("");
		} finally {
			server.closeAllConnections();
			await new Promise<void>((r) => server.close(() => r()));
		}
	}, 60_000);
});
