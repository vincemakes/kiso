#!/usr/bin/env node
/**
 * kiso-mcp-faults.mjs — B2 research, no model, no spend: two MCP faults in the middle of a program,
 * through the real runtime + bridge + the mock studio server (scripted sink).
 *   disconnect  the server process exits right after replying to its 2nd tool call
 *   drift       after the 1st call add_subject's signature changes server-side (name -> title)
 * Prints what the program returned, the ledger (per execution), what the server did, and the time taken.
 * usage: node kiso-mcp-faults.mjs <worktree root> <disconnect|drift> [guard]
 *   guard: the program extension checks each tool's live contract against the one it was admitted with
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFakeLlm } from "../mcp-ptc/fake-llm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const [ROOT, MODE, GUARD] = process.argv.slice(2);
if (!ROOT || !["disconnect", "drift"].includes(MODE ?? "")) { console.error("usage: node kiso-mcp-faults.mjs <worktree root> <disconnect|drift> [guard]"); process.exit(2); }
const SERVER = join(HERE, "..", "mcp-ptc", "server.mjs");
const SCRIPT = `
const out = [];
const p = await tools.mcp__studio__create_project({ name: "Fault", budget_credits: 100 });
out.push("project " + p.project_id);
for (const n of ["Fox", "Owl", "Hare"]) {
  try { const s = await tools.mcp__studio__add_subject({ project_id: p.project_id, name: n }); out.push("subject " + s.subject_id); }
  catch (e) { out.push("FAILED add_subject " + n + ": " + String(e.message).slice(0, 160)); }
}
return out;
`;
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const { createAgent, SessionStore } = await imp("packages/runtime/dist/index.js");
const mcp = (await imp("extensions/mcp/dist/kiso-mcp.mjs")).default;
const { createProgramExtension, hideTools, connectWait } = await imp("extensions/program/dist/kiso-program.mjs");
const root = mkdtempSync(join(tmpdir(), "mcp-faults-")); const snap = join(root, "snap.json"); const store = join(root, "store"); mkdirSync(store);
const llm = await startFakeLlm(join(root, "req"), { delayMs: 200, respond: (n) => (n === 1 ? { toolCalls: [{ id: "p1", name: "program", arguments: { code: SCRIPT } }] } : null) });
const env = { MCP_TOOLS: "13", MCP_SNAPSHOT: snap, ...(MODE === "disconnect" ? { MCP_EXIT_AFTER: "2" } : { MCP_DRIFT_AFTER: "1" }) };
const bridge = await mcp({ servers: { studio: { command: process.execPath, args: [SERVER], env } } });
const agent = createAgent({ model: "m", provider: "openai-compat", baseUrl: llm.url, apiKey: "x", tools: [], store: new SessionStore(store), extensions: [createProgramExtension({}, GUARD === "guard" ? { binding: bridge } : {}), hideTools(bridge), connectWait(bridge, 10_000)], systemPrompt: "You are a test agent." });
const session = await agent.session({ id: "s" });
const t0 = Date.now(); let result = "";
const timer = setTimeout(() => { console.log("HUNG: no end after 40 s"); process.exit(1); }, 40_000);
for await (const ev of session.run("go")) if (ev.type === "tool_result" && ev.callId === "p1") result = ev.content;
clearTimeout(timer);
console.log(`mode ${MODE}: finished in ${Date.now() - t0} ms\n--- program result seen by the model ---\n${result}`);
const file = join(store, readdirSync(store).find((f) => f.endsWith(".jsonl") && !f.includes("trace")));
const evs = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { const o = JSON.parse(l); return o.event ?? o; });
const rec = new Map(evs.filter((e) => e.type === "tool_execution_succeeded" || e.type === "tool_execution_failed").map((e) => [e.executionId, e.type.replace("tool_execution_", "") + (e.error ? `: ${String(e.error).slice(0, 110)}` : "")]));
console.log("--- ledger ---");
for (const e of evs.filter((x) => x.type === "tool_execution_started")) console.log(`${e.callId.padEnd(6)} ${e.name.replace("mcp__studio__", "").padEnd(16)} ${(e.binding?.digest ?? "no-binding").slice(0, 17).padEnd(17)} parent=${e.parent ?? "-"} ${rec.get(e.executionId) ?? "STARTED, NO RECEIPT (uncertain)"}`);
console.log(`uncertain after the run: ${session.uncertainExecutions().length}`);
try { const w = JSON.parse(readFileSync(snap, "utf8")); console.log(`--- server end state --- calls: ${JSON.stringify(w.calls)}; subjects: ${Object.keys(w.subjects).filter((k) => w.subjects[k].project && w.projects[w.subjects[k].project]?.name === "Fault").length}`); } catch { console.log("no snapshot"); }
await llm.close(); try { await bridge.dispose?.(); } catch { /* gone */ } process.exit(0);
