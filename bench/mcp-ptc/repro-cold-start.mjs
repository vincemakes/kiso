#!/usr/bin/env node
/**
 * repro-cold-start.mjs <kiso binary> [tools=13] — reproduce: the first model
 * request of a kiso session carries no MCP tools when the bridge has no tool
 * cache yet; a second session in the same KISO_HOME does.
 *
 * It starts a local OpenAI-compatible sink (fake-llm.mjs), configures the mock
 * MCP server in a fresh KISO_HOME, runs a one-line session TWICE in that home
 * and prints the tool names of each run's first request. No model, no network,
 * no spend. Expected on 0.48.0 with 13 tools: run 1 -> 9 tools (0 from the
 * server, only mcp__status), run 2 -> 22 tools (13 from the server).
 *
 * A session that ends before the background connect settles (about 0.3 s here)
 * never writes the cache, so with a larger catalog run 1 can leave no cache and
 * run 2 repeats the cold start; `--linger` keeps stdin open for 12 s so the
 * connect settles in every case.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeLlm } from "./fake-llm.mjs";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const linger = process.argv.includes("--linger");
const [KISO, TOOLS = "13"] = args;
if (!KISO) { console.error("usage: repro-cold-start.mjs <kiso binary> [tools] [--linger]"); process.exit(2); }
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "server.mjs");
const root = mkdtempSync(join(tmpdir(), "mcp-cold-"));
const home = join(root, "kiso-home"); mkdirSync(home, { recursive: true });
writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { studio: { command: process.execPath, args: [SERVER], env: { MCP_TOOLS: TOOLS } } } }));

async function session(label) {
	const dir = join(root, label); mkdirSync(join(dir, "work"), { recursive: true });
	const llm = await startFakeLlm(join(dir, "req"));
	const feed = linger ? `(echo "say hi"; sleep 12) | ` : `echo "say hi" | `;
	const p = spawn("sh", ["-c", `${feed}"${KISO}" --mode bypass repro`], { cwd: join(dir, "work"), detached: true, stdio: "ignore", env: { PATH: process.env.PATH, HOME: join(dir, "h"), OPENAI_BASE_URL: llm.url, OPENAI_API_KEY: "x", OPENAI_MODEL: "m", KISO_HOME: home, KISO_SESSIONS_DIR: join(home, `sessions-${label}`), KISO_NO_UPDATE_CHECK: "1" } });
	const kill = () => { try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ } };
	const t = setTimeout(kill, linger ? 16_000 : 30_000);
	await new Promise((r) => p.on("exit", r)); clearTimeout(t); kill();
	let names = null;
	try { names = JSON.parse(readFileSync(join(dir, "req", "req-1.json"), "utf8")).tools.map((x) => x.function?.name ?? x.name); } catch { /* none */ }
	await llm.close();
	const fromServer = (names ?? []).filter((n) => n.startsWith("mcp__studio__")).length;
	console.log(`${label}: ${names ? `${names.length} tools in the first request, ${fromServer} of them from the MCP server` : "no request captured"}`);
}
await session("run-1-no-cache");
await session("run-2-same-home");
