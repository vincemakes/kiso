#!/usr/bin/env node
/**
 * final-concurrency.mjs — the FINAL build, no model, no spend: how many MCP calls are really in flight at the server?
 * Two programs in one model turn, each 20 independent reads, the host declaring five read tools `shared`
 * (and, in "two-concurrent", the program tool itself `shared` so the kernel lets both programs run at once).
 * Observed at the SERVER (the mock counts calls in flight itself), not from the session log.
 * usage: node final-concurrency.mjs <worktree root> <exclusive|two-concurrent> [bound]
 */
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFakeLlm } from "../mcp-ptc/fake-llm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const [ROOT, COND, BOUND = "8"] = process.argv.slice(2);
if (!ROOT || !["exclusive", "two-concurrent"].includes(COND ?? "")) { console.error("usage: node final-concurrency.mjs <worktree root> <exclusive|two-concurrent> [bound]"); process.exit(2); }
const SERVER = join(HERE, "..", "mcp-ptc", "server.mjs");
const READS = new Set(["list_subjects", "list_assets", "get_subject", "get_asset", "wallet_balance"]);
const CODE = (tag) => `const rs = await Promise.all(Array.from({ length: 20 }, () => tools.mcp__studio__list_subjects({ project_id: "p_1" }))); return "${tag}:" + rs.length;`;
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const { createAgent, SessionStore } = await imp("packages/runtime/dist/index.js");
const mcp = (await imp("extensions/mcp/dist/kiso-mcp.mjs")).default;
const { createProgramExtension, hideTools, withEffects, connectWait } = await imp("extensions/program/dist/kiso-program.mjs");
const root = mkdtempSync(join(tmpdir(), "final-conc-")); const store = join(root, "store"); mkdirSync(store); const stats = join(root, "inflight.json");
const llm = await startFakeLlm(join(root, "req"), { delayMs: 100, respond: (n) => (n === 1 ? { toolCalls: [{ id: "pa", name: "program", arguments: { code: CODE("a") } }, { id: "pb", name: "program", arguments: { code: CODE("b") } }] } : null) });
const bridge = await mcp({ servers: { studio: { command: process.execPath, args: [SERVER], env: { MCP_TOOLS: "13", MCP_LATENCY_MS: "100", MCP_INFLIGHT_FILE: stats } } } });
const certified = withEffects(bridge, (t) => (READS.has(t.name.replace("mcp__studio__", "")) ? { concurrency: "shared" } : undefined));
let front = createProgramExtension({}, { maxConcurrentChildren: Number(BOUND) });
if (COND === "two-concurrent") front = withEffects(front, (t) => (t.name === "program" ? { concurrency: "shared" } : undefined), { allowSharedProgram: true }); // research only: every child here is a shared read
const agent = createAgent({ model: "m", provider: "openai-compat", baseUrl: llm.url, apiKey: "x", tools: [], store: new SessionStore(store), extensions: [front, hideTools(certified), connectWait(bridge, 10_000)], systemPrompt: "t" });
const session = await agent.session({ id: "s" });
const t0 = Date.now(); let programsOverlapped = 0;
const live = new Set();
for await (const ev of session.run("go")) {
	if (ev.type === "tool_execution_started" && !String(ev.callId).includes("/")) { live.add(ev.callId); programsOverlapped = Math.max(programsOverlapped, live.size); }
	if ((ev.type === "tool_execution_succeeded" || ev.type === "tool_execution_failed") && !String(ev.callId).includes("/")) live.delete(ev.callId);
}
const wall = Date.now() - t0;
await new Promise((r) => setTimeout(r, 200));
let server = {}; try { server = JSON.parse(readFileSync(stats, "utf8")); } catch { /* none */ }
console.log(JSON.stringify({ cond: COND, bound: Number(BOUND), programsRunningAtOnce: programsOverlapped, serverMaxInFlight: server.max, serverCalls: server.total, wallMs: wall }));
await llm.close(); try { await bridge.dispose?.(); } catch { /* gone */ } process.exit(0);
