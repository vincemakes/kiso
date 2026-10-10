#!/usr/bin/env node
/**
 * kiso-nested-crash.mjs — P3 experiment E-P3-1 (no model, no spend): the SAME
 * crash as bench/program/pi-nested-crash.mjs, run against kiso's program tool.
 *
 * Same mock MCP server, same scripted sink, same script text, same kill time. A
 * host process (kiso used as a library: createAgent + the program extension +
 * the MCP bridge with its tools hidden) runs a script that makes three
 * side-effecting calls; the third reply is held for 6 s after its effect; the
 * process group is killed with SIGKILL at 3.5 s. Then:
 *   1. the server's snapshot says which effects really happened;
 *   2. the session log says what the runtime durably knows (per execution);
 *   3. resume is attempted (blocked by the uncertain executions);
 *   4. after the human rules, what the model is told in its next request.
 *
 * usage: node kiso-nested-crash.mjs <worktree root>
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFakeLlm } from "../mcp-ptc/fake-llm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "mcp-ptc", "server.mjs");
const SCRIPT = `
const j = (r) => (typeof r === "string" ? JSON.parse(r) : r);
const p = await tools.mcp__studio__create_project({ name: "Crash", budget_credits: 100 });
const s = await tools.mcp__studio__add_subject({ project_id: p.project_id, name: "Fox" });
const a = await tools.mcp__studio__generate_asset({ subject_id: s.subject_id, style: "noir", call_id: "once" });
return { project: p.project_id, subject: s.subject_id, asset: a.asset_id };
`;

// ── host mode: one kiso process ────────────────────────────────────────────
if (process.argv[2] === "--host") {
	const [, , , ROOT, mode, store, url, snap] = process.argv;
	const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
	const { createAgent, SessionStore } = await imp("packages/runtime/dist/index.js");
	const mcp = (await imp("extensions/mcp/dist/kiso-mcp.mjs")).default;
	const { createProgramExtension, hideTools } = await imp("extensions/program/dist/kiso-program.mjs");
	const bridge = await mcp({ servers: { studio: { command: process.execPath, args: [SERVER], env: { MCP_TOOLS: "13", MCP_SNAPSHOT: snap, MCP_DELAY_AFTER: "generate_asset:6000" } } } });
	const agent = createAgent({ model: "m", provider: "openai-compat", baseUrl: url, apiKey: "x", tools: [], store: new SessionStore(store), extensions: [createProgramExtension(), hideTools(bridge)], systemPrompt: "You are a test agent." });
	const session = await agent.session({ id: "s" });
	if (mode === "run") {
		// the bridge connects in the background and the program's catalog is the request's table
		// snapshot: without this wait the first request has no MCP tools (findings-mcp-bridge, F1)
		await new Promise((r) => setTimeout(r, 1000));
		for await (const _ of session.run("create the asset")) void _;
	} else {
		const rows = () => [...session.uncertainExecutions()];
		try { for await (const _ of session.resume()) void _; console.log("RESUME: not blocked"); } catch (e) { console.log(`RESUME: ${e.message}`); }
		const before = rows().sort((a, b) => b.callId.length - a.callId.length); // children first
		for (const u of before) await session.resolveUncertain(u.executionId, "abandoned");
		console.log(`RULED: ${before.map((u) => `${u.callId}(${u.name})`).join(", ")} -> abandoned`);
		for await (const _ of session.resume()) void _; // continue the interrupted run: the model gets its next request
	}
	process.exit(0);
}

// ── driver ──────────────────────────────────────────────────────────────────
const ROOT = process.argv[2];
if (!ROOT) { console.error("usage: node kiso-nested-crash.mjs <worktree root>"); process.exit(2); }
const root = mkdtempSync(join(tmpdir(), "kiso-crash-"));
const store = join(root, "store"), snap = join(root, "snap.json");
mkdirSync(store);
const llm = await startFakeLlm(join(root, "req"), {
	delayMs: 1500, // a model takes time; the bridge connects in the meantime (the cold start window)
	respond: (n) => (n === 1 ? { toolCalls: [{ id: "p1", name: "program", arguments: { code: SCRIPT } }] } : null),
});
const run = (mode, storeDir, killAfterMs) => new Promise((resolve) => {
	const p = spawn(process.execPath, [fileURLToPath(import.meta.url), "--host", ROOT, mode, storeDir, llm.url, snap], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: join(root, "home"), KISO_HOME: join(root, "kiso-home") } });
	let out = "", err = ""; p.stdout.on("data", (c) => { out += c; }); p.stderr.on("data", (c) => { err += c; });
	const t = setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ } }, killAfterMs);
	p.on("exit", (code, sig) => { clearTimeout(t); try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ } resolve({ code, sig, out, err }); });
});

const r1 = await run("run", store, 4500);
console.log(`run 1: ended by ${r1.sig ?? r1.code} after 4.5 s (1 s bridge wait + 1.5 s model + the script, still waiting for generate_asset)`);
if (r1.code !== null) { console.log("host stderr:", r1.err.slice(0, 1200)); process.exit(1); }
await new Promise((r) => setTimeout(r, 400));
const world = JSON.parse(readFileSync(snap, "utf8"));
const proj = Object.values(world.projects).find((x) => x.name === "Crash");
console.log(`1) server snapshot (what really happened): project Crash: ${!!proj}; its subjects: ${proj ? Object.values(world.subjects).filter((x) => x.project === proj.id).length : 0}; its assets: ${proj ? Object.values(world.assets).filter((x) => x.project === proj.id).length : 0}; calls: ${JSON.stringify(world.calls)}`);

const file = join(store, readdirSync(store).find((f) => f.endsWith(".jsonl") && !f.includes("trace") && !f.startsWith("sub-")));
const events = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { const o = JSON.parse(l); return o.event ?? o; });
const startedEv = events.filter((e) => e.type === "tool_execution_started");
const receipts = new Map(events.filter((e) => e.type === "tool_execution_succeeded" || e.type === "tool_execution_failed").map((e) => [e.executionId, e.type.replace("tool_execution_", "")]));
console.log(`2) session log after the kill: ${startedEv.map((e) => `${e.callId} ${e.name} ${receipts.get(e.executionId) ?? "STARTED, NO RECEIPT (uncertain)"}`).join(" | ")}`);

// the crashed state, as a copy without the dead process's lock
const crashed = join(root, "crashed");
cpSync(store, crashed, { recursive: true, filter: (src) => !/\.lock$|\.lock\//.test(src) });
const before = llm.count();
const r2 = await run("resume", crashed, 30000);
for (const line of r2.out.split("\n").filter(Boolean)) console.log(`3) ${line}`);
const next = JSON.parse(readFileSync(join(root, "req", `req-${before + 1}.json`), "utf8"));
const tail = next.messages.slice(-3).map((m) => `${m.role}${m.tool_calls ? `[tool_calls:${m.tool_calls.map((c) => c.function.name).join(",")}]` : ""}${m.role === "tool" ? `: ${String(m.content).replace(/\s+/g, " ").slice(0, 420)}` : ""}`);
console.log(`4) what the model is told on its next request:\n   ${tail.join("\n   ")}`);
await llm.close();
