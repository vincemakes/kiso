#!/usr/bin/env node
/**
 * shared-reads.mjs — the "host-certified read-only concurrency" experiment (no model, no spend, existing kernel).
 *
 * The same scripted task runs through the real runtime + MCP bridge + the mock studio server (every call answered
 * after MCP_LATENCY_MS, calls in flight together answered together), in four conditions:
 *   program|plan  x  baseline (the bridge's tools declare nothing: the kernel runs each child alone)
 *                    shared   (the HOST declares `concurrency: "shared"` for five tools it has checked are pure reads)
 * Task: 12 independent reads -> one write (create_project) -> 6 independent reads of the new project.
 * Observed from the session log: the most children in flight at once, whether the write waited for every earlier read
 * (the fence) and every later read waited for the write, wall time, and the answers.
 * usage: node shared-reads.mjs <worktree root> <program|plan> <baseline|shared> [latencyMs]
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFakeLlm } from "../mcp-ptc/fake-llm.mjs";
import { studioEffects } from "./studio-effects.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const [ROOT, ARM, COND, LAT = "100"] = process.argv.slice(2);
if (!ROOT || !["program", "plan"].includes(ARM ?? "") || !["baseline", "shared"].includes(COND ?? "")) { console.error("usage: node shared-reads.mjs <worktree root> <program|plan> <baseline|shared> [latencyMs]"); process.exit(2); }
const SERVER = join(HERE, "..", "mcp-ptc", "server.mjs");
const READS = Number(process.env.READS ?? 12);
const SHARED_READS = new Set(["list_subjects", "list_assets", "get_subject", "get_asset", "wallet_balance"]);
const PROGRAM = `
const rs = await Promise.all(Array.from({ length: ${READS} }, (_, i) => tools.mcp__studio__list_subjects({ project_id: i % 2 ? "p_1" : "p_2" })));
const p = await tools.mcp__studio__create_project({ name: "Shared", budget_credits: 10 });
const ws = await Promise.all(Array.from({ length: 6 }, () => tools.mcp__studio__wallet_balance({ project_id: p.project_id })));
return { reads: rs.length, project: p.project_id, wallets: ws.length };`;
const PLAN = `
const rs = map(["p_2","p_1","p_2","p_1","p_2","p_1","p_2","p_1","p_2","p_1","p_2","p_1"], (id) => call("mcp__studio__list_subjects", { project_id: id }));
const p = call("mcp__studio__create_project", { name: "Shared", budget_credits: 10 });
const ws = map([1,2,3,4,5,6], (i) => call("mcp__studio__wallet_balance", { project_id: p.project_id, n: i }));
output({ reads: len(rs), project: p.project_id, wallets: len(ws) });`;
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const { createAgent, SessionStore } = await imp("packages/runtime/dist/index.js");
const mcp = (await imp("extensions/mcp/dist/kiso-mcp.mjs")).default;
const { createProgramExtension, createPlanExtension, hideTools, withEffects, connectWait } = await imp("extensions/program/dist/kiso-program.mjs");
const root = mkdtempSync(join(tmpdir(), "shared-reads-")); const store = join(root, "store"); mkdirSync(store);
const llm = await startFakeLlm(join(root, "req"), { delayMs: 100, respond: (n) => (n === 1 ? { toolCalls: [{ id: "p1", name: ARM, arguments: { code: ARM === "program" ? PROGRAM : PLAN } }] } : null) });
const bridge = await mcp({ servers: { studio: { command: process.execPath, args: [SERVER], env: { MCP_TOOLS: "13", MCP_LATENCY_MS: LAT } } } });
const certified = COND === "shared" ? withEffects(bridge, (t) => (SHARED_READS.has(t.name.replace("mcp__studio__", "")) ? { concurrency: "shared" } : undefined)) : bridge;
const front = ARM === "program" ? createProgramExtension() : createPlanExtension({ effects: studioEffects, mode: "parallel" });
const agent = createAgent({ model: "m", provider: "openai-compat", baseUrl: llm.url, apiKey: "x", tools: [], store: new SessionStore(store), extensions: [front, hideTools(certified), connectWait(bridge, 10_000)], systemPrompt: "You are a test agent." });
const session = await agent.session({ id: "s" });
let result = ""; let t0 = 0;
for await (const ev of session.run("go")) {
	if (ev.type === "tool_execution_started" && ev.callId === "p1/1" && t0 === 0) t0 = Date.now();
	if (ev.type === "tool_result" && ev.callId === "p1") result = ev.content;
}
const wall = Date.now() - t0;
const file = join(store, readdirSync(store).find((f) => f.endsWith(".jsonl") && !f.includes("trace")));
const evs = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { const o = JSON.parse(l); return o.event ?? o; }).filter((e) => String(e.callId ?? "").startsWith("p1/"));
let inflight = 0, maxIn = 0; const ids = new Map(); let writeStartedAt = -1, lastEarlyReceipt = -1, firstLateStart = Infinity;
evs.forEach((e, i) => {
	if (e.type === "tool_execution_started") { ids.set(e.executionId, e.name); inflight++; maxIn = Math.max(maxIn, inflight); if (e.name.endsWith("create_project")) writeStartedAt = i; else if (writeStartedAt >= 0) firstLateStart = Math.min(firstLateStart, i); }
	if (e.type === "tool_execution_succeeded" || e.type === "tool_execution_failed") { inflight--; if (writeStartedAt < 0) lastEarlyReceipt = i; }
});
const fenceOk = lastEarlyReceipt < writeStartedAt; // every early read was receipted before the write started
let writeReceipt = evs.findIndex((e, i) => i > writeStartedAt && e.executionId === [...ids.entries()].find(([, n]) => n.endsWith("create_project"))[0] && e.type !== "tool_execution_started");
const lateAfterWrite = firstLateStart > writeReceipt;
console.log(JSON.stringify({ arm: ARM, cond: COND, latencyMs: Number(LAT), childrenStarted: ids.size, maxChildrenInFlight: maxIn, wallMs: wall, writeWaitedForEarlierReads: fenceOk, laterReadsWaitedForWrite: lateAfterWrite, answer: result.replace(/\s+/g, " ").slice(0, 160) }));
await llm.close(); try { await bridge.dispose?.(); } catch { /* gone */ } process.exit(0);
