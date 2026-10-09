#!/usr/bin/env node
/**
 * rent-probe.mjs <ref binary> <kiso binary> — for every arm x catalog size,
 * start the arm against the fake endpoint with the mock MCP server configured,
 * read its FIRST request and report what the model would be shown: the tool
 * names, the bytes of the tool table, the bytes of the system prompt. No model,
 * no spend. This is the mechanism check (does each arm expose tools the way the
 * design says) and the rent measurement in one.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeLlm } from "./fake-llm.mjs";

const [REF, KISO] = process.argv.slice(2);
if (!REF || !KISO) { console.error("usage: rent-probe.mjs <pi binary> <kiso binary>"); process.exit(2); }
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "server.mjs");
const root = mkdtempSync(join(tmpdir(), "mcp-ptc-probe-"));
const ARMS = [["P-direct", "direct"], ["P-deferred", "deferred"], ["P-codemode", "codemode"], ["K-direct-cold", null], ["K-direct", null]];
const SIZES = (process.env.PROBE_SIZES ?? "13,40,120").split(",").map(Number);
const rows = [];

const mcp = (tools, exposure) => ({ mcpServers: { studio: { command: process.execPath, args: [SERVER], env: { MCP_TOOLS: String(tools), MCP_VOLUME: "small", MCP_SNAPSHOT: join(root, "snap.json") }, ...(exposure ? { exposure, description: "Studio production tools: projects, subjects, assets, board, approval, credits, plus workspace services" } : {}) } } });
// ASYNC on purpose: the fake endpoint lives in this process, so a blocking spawn would stop it
// from answering. The arm runs in its own process group and the whole group is killed on timeout.
const run = (cmd, args, opts) => new Promise((resolve) => {
	const p = spawn(cmd, args, { ...opts, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	let err = ""; p.stderr.on("data", (c) => { err += c; }); p.stdout.resume();
	const t = setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ } }, Number(process.env.PROBE_TIMEOUT_MS ?? 45_000));
	p.on("exit", (status) => { clearTimeout(t); try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ } resolve({ status, stderr: err }); });
});

for (const size of SIZES) for (const [arm, exposure] of ARMS) {
	const dir = join(root, `${arm}-${size}`); mkdirSync(dir, { recursive: true });
	const llm = await startFakeLlm(join(dir, "req"));
	let r;
	if (exposure) {
		const home = join(dir, "home"); mkdirSync(join(home, ".pi/agent"), { recursive: true });
		writeFileSync(join(home, ".pi/agent/mcp.json"), JSON.stringify(mcp(size, exposure)));
		writeFileSync(join(home, ".pi/agent/models.json"), JSON.stringify({ providers: { route: { baseUrl: llm.url, api: "openai-completions", apiKey: "fake", models: [{ id: "m", reasoning: true, contextWindow: 1000000, maxTokens: 8000 }] } } }));
		const work = join(dir, "work"); mkdirSync(work);
		r = await run(REF, ["--provider", "route", "--model", "m", "--thinking", "off", "-p", "--mode", "json", "--session", join(dir, "session"), "say hi"], { cwd: work, env: { PATH: process.env.PATH, HOME: home } });
	} else {
		const kh = join(dir, "kiso-home"); mkdirSync(kh, { recursive: true });
		writeFileSync(join(kh, "mcp.json"), JSON.stringify(mcp(size, null)));
		if (arm === "K-direct") await new Promise((res, rej) => { const q = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "leg-config.mjs"), "K-direct", String(size), "small", join(dir, "overlay"), join(root, "snap.json")], { stdio: "inherit" }); q.on("exit", (c) => (c === 0 ? res() : rej(new Error("leg-config failed")))); }), writeFileSync(join(kh, "mcp-tools.json"), readFileSync(join(dir, "overlay", "mcp-tools.json")));
		const work = join(dir, "work"); mkdirSync(work);
		r = await run("sh", ["-c", `echo "say hi" | "${KISO}" --mode bypass probe`], { cwd: work, env: { PATH: process.env.PATH, HOME: join(dir, "bare"), OPENAI_BASE_URL: llm.url, OPENAI_API_KEY: "fake", OPENAI_MODEL: "m", KISO_HOME: kh, KISO_SESSIONS_DIR: join(kh, "sessions"), KISO_NO_UPDATE_CHECK: "1" } });
	}
	let first = null;
	try { first = JSON.parse(readFileSync(join(dir, "req", "req-1.json"), "utf8")); } catch { /* none */ }
	await llm.close();
	if (!first) { rows.push({ arm, size, error: `no request captured (exit ${r.status}) ${String(r.stderr).slice(0, 200)}` }); continue; }
	const names = (first.tools ?? []).map((t) => t.function?.name ?? t.name);
	const sys = (first.messages ?? []).filter((m) => m.role === "system" || m.role === "developer").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("");
	rows.push({ arm, size, requests: llm.count(), nTools: names.length, studioVisible: names.filter((x) => /^(create_project|generate_asset|calendar_get)$|^mcp__/.test(x)).length, toolBytes: JSON.stringify(first.tools ?? []).length, systemBytes: sys.length, totalBytes: JSON.stringify(first).length, tools: names.length <= 14 ? names : `${names.slice(0, 10).join(",")},…` });
}
console.log(JSON.stringify(rows, null, 1));
