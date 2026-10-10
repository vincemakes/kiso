/**
 * SA-F1 — the delegation config reaches the subagent extension BEFORE it
 * loads.
 *
 * The CLI hands the extension what a delegated task may NAME (the
 * configured checks, evaluators and model profiles) and the folder this
 * process keeps its sessions in, through KISO_DELEGATION_CONFIG_JSON. The
 * extension reads it once, when it loads, to build the delegate schema and
 * the executor's one snapshot. The CLI used to assign the variable AFTER
 * the built-in layer had loaded the extension, so the extension read an
 * empty config: no `acceptance` and no `model` field, a configured check
 * refused, `subagents.model` ignored, and a project-layout child's
 * sessions in the legacy folder.
 *
 * Every test here drives the BUILT CLI — the order under test is the CLI's
 * own — and none constructs the extension by hand with the variable set
 * first (the extension-level tests do, which is the reverse of the CLI's
 * order and why they stayed green).
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");
const MODELS = {
	first: { kind: "openai-compat", model: "m-first", baseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: "SA_F1_KEY", contextWindow: 128000 },
	second: { kind: "openai-compat", model: "m-second", baseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: "SA_F1_KEY", contextWindow: 128000 },
};
const CHECK = 'node -e "process.exit(0)"';

type TaskItem = { properties: Record<string, { description?: string } | undefined> };

/** The first request the built CLI sends, with `config` as the home's. */
async function firstRequest(config: Record<string, unknown>): Promise<{ tools: { function: { name: string; parameters: { properties: { tasks: { items: TaskItem } } } } }[] }> {
	const bodies: string[] = [];
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let b = "";
		req.on("data", (c) => (b += c));
		req.on("end", () => {
			bodies.push(b);
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "the sink" } }));
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	try {
		const { dirs, env } = isolatedEnv({ SA_F1_KEY: "DUMMY" });
		writeFileSync(
			join(dirs.home, "config.json"),
			JSON.stringify({ model: "sink", ...config, models: { sink: { kind: "openai-compat", model: "m-sink", baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "SA_F1_KEY", contextWindow: 128000 }, ...((config.models as object | undefined) ?? {}) } }),
		);
		const child = spawn(process.execPath, [CLI, "-p", "hello"], { env, cwd: dirs.home, stdio: "ignore" });
		const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
		await new Promise<void>((r) => child.on("exit", () => r()));
		clearTimeout(timer);
		await new Promise((r) => setTimeout(r, 100));
	} finally {
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
	}
	expect(bodies.length, "the CLI sent no request to the sink").toBeGreaterThan(0);
	return JSON.parse(bodies[0]!);
}

describe("SA-F1 — the delegate schema carries what the user configured", () => {
	it("a configured check and evaluator make `acceptance` appear and name them; two profiles make `model` appear and name them", async () => {
		const req = await firstRequest({ checks: { test: CHECK }, evaluators: ["/opt/evaluators/judge.sh"], models: { ...MODELS } });
		const item = req.tools.find((t) => t.function.name === "delegate")!.function.parameters.properties.tasks.items;
		const acceptance = item.properties.acceptance?.description;
		expect(acceptance, "acceptance is absent from the delegate task item").toBeDefined();
		expect(acceptance).toContain("{ check: test }");
		expect(acceptance).toContain("{ evaluator: ");
		expect(acceptance).not.toMatch(/none configured/);
		const model = item.properties.model?.description;
		expect(model, "model is absent from the delegate task item").toBeDefined();
		expect(model).toContain("first");
		expect(model).toContain("second");
		expect(model).not.toMatch(/\bnone\b/);
	}, 60_000);

	it("a home that configures neither offers neither (the bare composition is unchanged)", async () => {
		const req = await firstRequest({});
		const item = req.tools.find((t) => t.function.name === "delegate")!.function.parameters.properties.tasks.items;
		expect(Object.keys(item.properties)).not.toContain("acceptance");
		// the sink profile is the one configured profile, so `model` is offered
		expect(item.properties.model?.description).toContain("sink");
	}, 60_000);
});

describe("SA-F1 — the executor and the child use the same configuration", () => {
	let argv: string[] = [];
	let childSessionsDir = "";
	let home = "";
	let delegateResult = "";

	beforeAll(() => {
		const { dirs, env } = isolatedEnv({ KISO_MODE: "bypass", SA_F1_KEY: "DUMMY" });
		home = dirs.home;
		// the per-project layout is in force only when no sessions dir is pinned
		delete env.KISO_SESSIONS_DIR;
		const work = mkdtempSync(join(tmpdir(), "kiso-sa-f1-ws-"));
		const ws = join(work, "ws");
		mkdirSync(ws);
		const g = (...a: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: ws });
		g("init", "-q");
		writeFileSync(join(ws, "a.txt"), "a\n");
		g("add", "-A");
		g("commit", "-qm", "base");
		const record = join(work, "child-record.json");
		const childBin = join(work, "child.mjs");
		writeFileSync(
			childBin,
			`import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const at = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: args, sessionsDir: process.env.KISO_SESSIONS_DIR ?? null }));
// a change, so a writer has a patch and its acceptance has something to check
appendFileSync("a.txt", "child\\n");
const result = at("--result-file");
writeFileSync(result, "done\\n\\nUNRESOLVED\\nnone\\n");
writeFileSync(join(dirname(result), "result.json"), JSON.stringify({ outcome: "completed", endedBy: "completed", requests: 1, toolCalls: 0, model: "m", profile: null }));
`,
		);
		writeFileSync(
			join(dirs.home, "config.json"),
			JSON.stringify({ models: { ...MODELS }, subagents: { model: "second" }, checks: { test: CHECK } }),
		);
		const script = [
			{ events: [{ type: "tool_call_end", callId: "d1", name: "delegate", input: { tasks: [{ role: "implementer", task: "touch a.txt", scope: ["a.txt"], acceptance: { check: "test" } }] } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] },
			{ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] },
		];
		writeFileSync(join(work, "faux.json"), JSON.stringify(script));
		const r = spawnSync(process.execPath, [CLI, "-p", "go"], {
			env: { ...env, KISO_FAUX_SCRIPT: join(work, "faux.json"), KISO_SUBAGENT_BIN: childBin },
			cwd: ws,
			encoding: "utf8",
			timeout: 90_000,
		});
		expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
		const recorded = existsSync(record) ? (JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; sessionsDir: string | null }) : { argv: [], sessionsDir: null };
		argv = recorded.argv;
		childSessionsDir = recorded.sessionsDir ?? "";
		// the delegate call's own result, from the parent's session
		const folders = [join(home, "projects"), join(home, "sessions")].filter(existsSync);
		for (const dir of folders) {
			const stack = [dir];
			while (stack.length > 0) {
				const d = stack.pop()!;
				for (const e of readdirSync(d, { withFileTypes: true })) {
					if (e.isDirectory()) {
						if (e.name !== "traces") stack.push(join(d, e.name));
					} else if (e.name.endsWith(".jsonl") && !e.name.startsWith("sub-")) {
						for (const line of readFileSync(join(d, e.name), "utf8").split("\n")) {
							if (line.trim() === "") continue;
							// a session file also holds records that are not events (a header)
							const ev = (JSON.parse(line) as { event?: { type: string; callId?: string; content?: unknown } }).event;
							if (ev?.type === "tool_result" && ev.callId === "d1") delegateResult = String(ev.content);
						}
					}
				}
			}
		}
	}, 120_000);

	it("a configured check can be named as acceptance — the call is not refused, and the check runs", () => {
		expect(delegateResult, "the delegate call's result was not found in the parent's session").not.toBe("");
		expect(delegateResult).not.toMatch(/refused|schema validation|additional properties/);
		// the parent ran the named check after the child completed: the
		// foreground handoff says "verification: check PASSED", and where
		// writers are collected (0.49.0 B) the patch line says "child
		// acceptance: PASSED"
		expect(delegateResult).toMatch(/verification: check PASSED · exit 0|child acceptance: PASSED/);
	});

	it("`subagents.model` is honoured — the child starts on that profile", () => {
		expect(argv, "the child never started").not.toEqual([]);
		expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2)).toEqual(["--model", "second"]);
	});

	it("in a project-layout home, the child's sessions go to the parent's project folder — never the legacy one", () => {
		expect(childSessionsDir).not.toBe("");
		expect(childSessionsDir.startsWith(join(home, "projects"))).toBe(true);
		expect(existsSync(join(home, "sessions"))).toBe(false);
	});
});
