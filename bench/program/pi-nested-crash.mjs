#!/usr/bin/env node
/**
 * pi-nested-crash.mjs <reference binary> — P0 experiment E-P0-1 (no model, no
 * spend): what does the reference implementation's script tool leave behind when
 * the process dies in the middle of a script whose earlier tool calls already
 * took effect?
 *
 * A local OpenAI-compatible sink scripts the "model": its first answer is one
 * `codemode` call whose script makes three calls against the mock MCP server
 * (create a project, add a subject, generate an asset). The server applies each
 * call at once but answers `generate_asset` only after 6 s (MCP_DELAY_AFTER), so
 * the effect has happened and its result has not been delivered when the process
 * group is killed with SIGKILL at ~3 s. Then:
 *   1. the server's snapshot says which effects really happened;
 *   2. the session file says what the agent durably knows;
 *   3. a second run on the same session shows what the model is told on resume.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeLlm } from "../mcp-ptc/fake-llm.mjs";

const REF = process.argv[2];
if (!REF) { console.error("usage: pi-nested-crash.mjs <reference binary>"); process.exit(2); }
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp-ptc", "server.mjs");
const root = mkdtempSync(join(tmpdir(), "pi-crash-"));
const home = join(root, "home"); mkdirSync(join(home, ".pi/agent"), { recursive: true });
const work = join(root, "work"); mkdirSync(work);
const snap = join(root, "snap.json"), session = join(root, "session");

const SCRIPT = `
const j = (r) => JSON.parse(r.content[0].text);
const p = j(await tools.mcp__studio__create_project({ name: "Crash", budget_credits: 100 }));
const s = j(await tools.mcp__studio__add_subject({ project_id: p.project_id, name: "Fox" }));
const a = j(await tools.mcp__studio__generate_asset({ subject_id: s.subject_id, style: "noir", call_id: "once" }));
return { project: p.project_id, subject: s.subject_id, asset: a.asset_id };
`;
const llm = await startFakeLlm(join(root, "req"), {
	respond: (n, body) => (n === 1 || (body.messages ?? []).length <= 2 && n === 1
		? { toolCalls: [{ id: "call_script_1", name: "codemode", arguments: { code: SCRIPT } }] } : null),
});
writeFileSync(join(home, ".pi/agent/models.json"), JSON.stringify({ providers: { route: { baseUrl: llm.url, api: "openai-completions", apiKey: "!echo fake", models: [{ id: "m", reasoning: true, contextWindow: 1000000, maxTokens: 8000 }] } } }));
writeFileSync(join(home, ".pi/agent/mcp.json"), JSON.stringify({ mcpServers: { studio: { command: process.execPath, args: [SERVER], env: { MCP_TOOLS: "13", MCP_SNAPSHOT: snap, MCP_DELAY_AFTER: "generate_asset:6000" }, exposure: "codemode", description: "Studio tools" } } }));

const run = (prompt, killAfterMs) => new Promise((resolve) => {
	const p = spawn(REF, ["--provider", "route", "--model", "m", "--thinking", "off", "-p", "--mode", "json", "--session", session, prompt], { cwd: work, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: home } });
	p.stdout.resume(); p.stderr.resume();
	const t = setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ } }, killAfterMs);
	p.on("exit", (code, sig) => { clearTimeout(t); try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ } resolve({ code, sig }); });
});

const r1 = await run("create the asset", 3500);
console.log(`run 1: ended by ${r1.sig ?? r1.code} after 3.5 s (the script was still waiting for generate_asset)`);
await new Promise((r) => setTimeout(r, 500));
const world = JSON.parse(readFileSync(snap, "utf8"));
const myProj = Object.values(world.projects).find((x) => x.name === "Crash");
const subj = myProj && Object.values(world.subjects).filter((x) => x.project === myProj.id);
const assets = myProj && Object.entries(world.assets).filter(([, a]) => a.project === myProj.id);
console.log(`1) server snapshot (what really happened): project Crash: ${!!myProj}; its subjects: ${subj?.length ?? 0}; its assets: ${assets?.length ?? 0}; calls: ${JSON.stringify(world.calls)}`);

const lines = readFileSync(session, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const msgs = lines.filter((e) => e.type === "message").map((e) => e.message);
console.log(`2) session file after the kill: ${lines.length} entries; messages: ${msgs.map((m) => m.role + (m.role === "assistant" ? `[${(m.content ?? []).map((b) => b.type === "toolCall" ? `toolCall:${b.name}` : b.type).join(",")}]` : m.role === "toolResult" ? `[${m.toolName}]` : "")).join(" -> ")}`);
const nestedInFile = JSON.stringify(lines).includes("nestedCalls") || JSON.stringify(lines).includes("mcp__studio__create_project\"") ;
console.log(`   any trace of a nested call (nestedCalls / the inner tool names as events): ${JSON.stringify(lines).includes("nestedCalls")}`);

const before = llm.count();
const r2 = await run("what happened to the asset?", 20000);
const resumed = JSON.parse(readFileSync(join(root, "req", `req-${before + 1}.json`), "utf8"));
const tail = resumed.messages.slice(-4).map((m) => `${m.role}${m.tool_calls ? `[tool_calls:${m.tool_calls.map((c) => c.function.name).join(",")}]` : ""}${m.role === "tool" ? `:${String(m.content).slice(0, 110)}` : ""}`);
console.log(`3) resume (run 2 ended by ${r2.sig ?? r2.code}): the first request of the new run ends with: ${tail.join(" | ")}`);
const world2 = JSON.parse(readFileSync(snap, "utf8"));
console.log(`   server calls after run 2: ${JSON.stringify(world2.calls)}`);
await llm.close();
