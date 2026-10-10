#!/usr/bin/env node
/**
 * plan-smoke.mjs — no model, no spend: a scripted model calls the `plan` tool against the real
 * kiso runtime + MCP bridge + the mock studio server; prints what the model would be told, the
 * ledger shape and the server's end state. usage: node plan-smoke.mjs <worktree root>
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFakeLlm } from "../mcp-ptc/fake-llm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[2];
const SERVER = join(HERE, "..", "mcp-ptc", "server.mjs");
const PLAN = `
const p = call("mcp__studio__create_project", { name: "Smoke", budget_credits: 100 });
const subs = map(["Fox", "Owl", "Hare"], (n) => call("mcp__studio__add_subject", { project_id: p.project_id, name: n }));
const assets = map(subs, (s) => call("mcp__studio__generate_asset", { subject_id: s.subject_id, style: "noir" }));
const checks = map(assets, (a) => call("mcp__studio__analyze_asset", { asset_id: a.asset_id }));
const bad = filter(checks, (c) => not(c.passes));
output({ project: p.project_id, assets: pluck(assets, "asset_id"), failing: len(bad), scores: pluck(checks, "score") });
`;
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const { createAgent, SessionStore } = await imp("packages/runtime/dist/index.js");
const mcp = (await imp("extensions/mcp/dist/kiso-mcp.mjs")).default;
const { createPlanExtension, hideTools, connectWait } = await imp("extensions/program/dist/kiso-program.mjs");
const root = mkdtempSync(join(tmpdir(), "plan-smoke-")); const snap = join(root, "snap.json"); const store = join(root, "store"); mkdirSync(store);
const llm = await startFakeLlm(join(root, "req"), { delayMs: 200, respond: (n) => (n === 1 ? { toolCalls: [{ id: "p1", name: "plan", arguments: { code: process.env.PLAN_CODE ?? PLAN } }] } : null) });
const bridge = await mcp({ servers: { studio: { command: process.execPath, args: [SERVER], env: { MCP_TOOLS: "13", MCP_SNAPSHOT: snap } } } });
const agent = createAgent({ model: "m", provider: "openai-compat", baseUrl: llm.url, apiKey: "x", tools: [], store: new SessionStore(store), extensions: [createPlanExtension({ effects: () => ({ kind: "unknown" }) }), hideTools(bridge), connectWait(bridge, 10_000)], systemPrompt: "You are a test agent." });
const session = await agent.session({ id: "s" });
const t0 = Date.now();
for await (const ev of session.run("smoke")) if (ev.type === "tool_result") console.log(`RESULT ${ev.callId} isError=${ev.isError}\n${ev.content}`);
console.log(`wall ${Date.now() - t0} ms; uncertain: ${session.uncertainExecutions().length}`);
const file = join(store, readdirSync(store).find((f) => f.endsWith(".jsonl") && !f.includes("trace")));
const evs = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { const o = JSON.parse(l); return o.event ?? o; });
console.log("started:", evs.filter((e) => e.type === "tool_execution_started").map((e) => `${e.callId}:${e.name.replace("mcp__studio__", "")}`).join(" "));
console.log("server calls:", JSON.stringify(JSON.parse(readFileSync(snap, "utf8")).calls));
await llm.close(); await bridge.dispose?.(); process.exit(0);
