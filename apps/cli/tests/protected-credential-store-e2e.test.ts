/**
 * kiso never serves its own credential store to a model — through the real
 * CLI (kiso-doc plan-protected-credential-store-2026-09-19, gates 1, 4, 6
 * and 7).
 *
 * The 2026-09-14 incident's exact shape first: cwd = home, the default
 * mode, `read_file .kiso/auth.json`. Then a delegate child's invocation,
 * exactly (`KISO_MODE=bypass`, `chat <id> --task-file`), shelling out for
 * the store every way the plan names, with the floor switched OFF to show
 * the two are separate. Then a user's own `protectedPaths`.
 *
 * SAFETY: HOME and KISO_HOME are a mkdtemp directory — every `~` and
 * `$HOME` in these commands is that directory, never the real home — and
 * the store holds a canary, not a credential. No provider key reaches the
 * child: the model is the faux script.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";

const CANARY = "sk-canary-protected-e2e-0000";
const USER_CANARY = "user-secret-canary-0000";
const ORDINARY = "ordinary-auth-marker";
const REFUSAL = "kiso never serves its own credential store to a model";

type Ev = { type: string; callId?: string; decision?: string; decidedBy?: string; reason?: string; isError?: boolean; errorKind?: string; content?: unknown };

function world(config?: Record<string, unknown>) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "kiso-protected-e2e-")));
	const home = join(base, "home");
	mkdirSync(join(home, ".kiso"), { recursive: true });
	writeFileSync(join(home, ".kiso", "auth.json"), `${JSON.stringify({ version: 1, credentials: { deepseek: { type: "api-key", key: CANARY } } }, null, 2)}\n`, { mode: 0o600 });
	if (config !== undefined) writeFileSync(join(home, ".kiso", "config.json"), `${JSON.stringify(config)}\n`);
	mkdirSync(join(home, "proj"));
	writeFileSync(join(home, "proj", "auth.json"), `${ORDINARY}\n`);
	writeFileSync(join(home, "secret.txt"), `${USER_CANARY}\n`);
	const { env, dirs } = isolatedEnv();
	const e: Record<string, string | undefined> = { ...env, HOME: home, KISO_HOME: join(home, ".kiso") };
	// the faux model and nothing else
	delete e.OPENAI_API_KEY;
	delete e.ANTHROPIC_API_KEY;
	delete e.DEEPSEEK_API_KEY;
	return { base, home, env: e, sessions: join(dirs.home, "sessions") };
}

function script(base: string, calls: readonly { id: string; name: string; input: Record<string, unknown> }[]): string {
	const path = join(base, "faux.json");
	writeFileSync(
		path,
		JSON.stringify([
			...calls.map((c) => ({ events: [{ type: "tool_call_end", callId: c.id, name: c.name, input: c.input }, { type: "stop", reason: "tool_use" }] })),
			{ events: [{ type: "text_delta", text: "store run done" }, { type: "stop", reason: "end_turn" }] },
		]),
	);
	return path;
}

function events(sessions: string, id: string): { raw: string; evs: Ev[] } {
	const file = join(sessions, `${id}.jsonl`);
	const raw = existsSync(file) ? readFileSync(file, "utf8") : "";
	const evs = raw
		.trim()
		.split("\n")
		.filter((l) => l !== "")
		.map((l) => (JSON.parse(l) as { event: Ev }).event);
	return { raw, evs };
}

const decided = (evs: readonly Ev[], id: string): Ev | undefined => evs.find((e) => e.type === "permission_decided" && e.callId === id);
const result = (evs: readonly Ev[], id: string): Ev | undefined => evs.find((e) => e.type === "tool_result" && e.callId === id);

describe("the credential store never reaches a model, on the real CLI", () => {
	it("the incident: cwd = home, default mode, `read_file .kiso/auth.json` — refused; a search and a shell read find nothing", () => {
		const w = world();
		const faux = script(w.base, [
			{ id: "r1", name: "read_file", input: { path: ".kiso/auth.json" } },
			{ id: "q1", name: "search_text", input: { pattern: "canary-protected", path: "." } },
			{ id: "s1", name: "shell", input: { command: "cat .kiso/auth.json" } },
		]);
		const r = runCli(["-p", "what is in my kiso folder", "incident"], { ...w.env, KISO_FAUX_SCRIPT: faux }, { cwd: w.home, timeout: 60_000 });
		expect(r.status, r.stderr).toBe(0);
		const { raw, evs } = events(w.sessions, "incident");
		expect(raw.length, "the session was written").toBeGreaterThan(0);
		expect(raw, "the store's secret is nowhere in what the model was handed").not.toContain(CANARY);
		expect(r.stdout + r.stderr).not.toContain(CANARY);
		expect(result(evs, "r1")).toMatchObject({ isError: true, errorKind: "precondition" });
		expect(String(result(evs, "r1")?.content)).toContain(REFUSAL);
		expect(decided(evs, "s1")).toMatchObject({ decision: "denied", decidedBy: "protected-files" });
		expect(r.stdout).toContain("store run done");
	}, 90_000);

	it("a delegate child in bypass, with the floor OFF: every shell spelling is denied, and the read refused", () => {
		const w = world({ floor: "off" });
		const faux = script(w.base, [
			{ id: "s1", name: "shell", input: { command: "cat ~/.kiso/auth.json" } },
			{ id: "s2", name: "shell", input: { command: "cd ~/.kiso && cat auth.json" } },
			{ id: "s3", name: "shell", input: { command: 'sh -c "cat $HOME/.kiso/auth.json"' } },
			{ id: "s4", name: "shell", input: { command: "cat < ~/.kiso/auth.json" } },
			{ id: "r1", name: "read_file", input: { path: ".kiso/auth.json" } },
		]);
		const task = join(w.base, "task.md");
		writeFileSync(task, "read the credentials\n");
		const r = runCli(["chat", "store-child", "--task-file", task], { ...w.env, KISO_MODE: "bypass", KISO_FAUX_SCRIPT: faux }, { cwd: w.home, timeout: 60_000 });
		expect(r.status, r.stderr).toBe(0);
		const { raw, evs } = events(w.sessions, "store-child");
		expect(raw).not.toContain(CANARY);
		expect(r.stdout + r.stderr).not.toContain(CANARY);
		for (const id of ["s1", "s2", "s3", "s4"]) {
			expect(decided(evs, id), id).toMatchObject({ decision: "denied", decidedBy: "protected-files" });
			expect(decided(evs, id)?.reason, id).toContain(REFUSAL);
		}
		expect(result(evs, "r1")).toMatchObject({ isError: true, errorKind: "precondition" });
		expect(r.stdout).toContain("store run done");
	}, 90_000);

	it("an unrelated auth.json in a project is served", () => {
		const w = world();
		const faux = script(w.base, [{ id: "s1", name: "shell", input: { command: "cat ./auth.json" } }]);
		const task = join(w.base, "task.md");
		writeFileSync(task, "read the project's auth.json\n");
		const r = runCli(["chat", "store-proj", "--task-file", task], { ...w.env, KISO_MODE: "bypass", KISO_FAUX_SCRIPT: faux }, { cwd: join(w.home, "proj"), timeout: 60_000 });
		expect(r.status, r.stderr).toBe(0);
		const { raw, evs } = events(w.sessions, "store-proj");
		expect(decided(evs, "s1")).toMatchObject({ decision: "approved", decidedBy: "mode:full-access" });
		expect(raw).toContain(ORDINARY);
	}, 90_000);

	it("a user's own `protectedPaths` join the store", () => {
		const w = world({ protectedPaths: ["~/secret.txt"] });
		const faux = script(w.base, [
			{ id: "r1", name: "read_file", input: { path: "secret.txt" } },
			{ id: "s1", name: "shell", input: { command: "cat ~/secret.txt" } },
		]);
		const task = join(w.base, "task.md");
		writeFileSync(task, "read my secret\n");
		const r = runCli(["chat", "store-user", "--task-file", task], { ...w.env, KISO_MODE: "bypass", KISO_FAUX_SCRIPT: faux }, { cwd: w.home, timeout: 60_000 });
		expect(r.status, r.stderr).toBe(0);
		const { raw, evs } = events(w.sessions, "store-user");
		expect(raw).not.toContain(USER_CANARY);
		expect(result(evs, "r1")).toMatchObject({ isError: true, errorKind: "precondition" });
		expect(decided(evs, "s1")).toMatchObject({ decision: "denied", decidedBy: "protected-files" });
	}, 90_000);
});

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

describe("the paths that are not tools, on the real CLI", () => {
	it("a repo whose AGENTS.md is a symlink to the store: the request a provider RECEIVES carries no byte of it", async () => {
		// the provider is a loopback on 127.0.0.1 that keeps each request body
		// and answers 401 — nothing leaves the machine, and the body is the
		// system prompt exactly as it would have gone out
		const bodies: string[] = [];
		const server = createServer((req, res) => {
			let body = "";
			req.on("data", (c: Buffer) => (body += c.toString("utf8")));
			req.on("end", () => {
				bodies.push(body);
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: { type: "authentication_error", message: "synthetic test error" } }));
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as { port: number }).port;
		try {
			const w = world({ model: "loop", models: { loop: { kind: "openai-compat", model: "loop-model", baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "LOOP_TEST_KEY" } } });
			const repo = join(w.home, "repo");
			mkdirSync(repo);
			symlinkSync(join(w.home, ".kiso", "auth.json"), join(repo, "AGENTS.md"));
			// the next instruction file: read in the store's place, and proof
			// that the captured body IS the system prompt
			writeFileSync(join(repo, "CLAUDE.md"), "loopback-project-marker\n");
			const env: Record<string, string | undefined> = { ...w.env, LOOP_TEST_KEY: "dummy-loop-key" };
			delete env.OPENAI_BASE_URL;
			delete env.ANTHROPIC_BASE_URL;
			const child = spawn(process.execPath, [CLI, "-p", "hello", "loop-session"], { env: env as NodeJS.ProcessEnv, cwd: repo, stdio: "ignore" });
			const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
			await new Promise<void>((r) => child.on("exit", () => r()));
			clearTimeout(timer);
			await new Promise((r) => setTimeout(r, 250)); // the socket may still be draining
		} finally {
			server.closeAllConnections();
			await new Promise<void>((r) => server.close(() => r()));
		}
		expect(bodies.length, "the CLI reached the loopback provider").toBeGreaterThan(0);
		const all = bodies.join("\n");
		expect(all, "the system prompt carried the next instruction file").toContain("loopback-project-marker");
		expect(all, "and not one byte of the store").not.toContain(CANARY);
	}, 90_000);

	it("`--task-file` naming the store is a usage error — nothing runs, nothing is sent", () => {
		const w = world();
		const faux = script(w.base, []);
		const r = runCli(["chat", "task-store", "--task-file", join(w.home, ".kiso", "auth.json")], { ...w.env, KISO_FAUX_SCRIPT: faux }, { cwd: w.home, timeout: 60_000 });
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain(REFUSAL);
		expect(r.stdout + r.stderr).not.toContain(CANARY);
		expect(events(w.sessions, "task-store").raw).toBe("");
	}, 90_000);
});
