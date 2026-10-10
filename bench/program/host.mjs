#!/usr/bin/env node
/**
 * host.mjs — kiso as a LIBRARY, shaped like the CLI so the benchmark runner can use
 * it as the kiso binary (run-t6.sh's kiso arm): the program arm of the MCP benchmark.
 *
 *   host.mjs --version
 *   host.mjs [--mode X] [--model NAME] <session-name>      prompts, one per line, on stdin
 *
 * The model comes from the leg's profile (`$KISO_HOME/config.json`, `models.<NAME>`:
 * baseUrl, model, headers with `{session}`), the key from OPENAI_API_KEY (the runner
 * injects it), the MCP servers from `$KISO_HOME/mcp.json`, the session log goes to
 * `$KISO_SESSIONS_DIR/<session-name>.jsonl` — the same record the CLI writes, so the
 * same extractor reads it.
 *
 * The agent has ONE tool (`program` or, with PROGRAM_ARM=plan, `plan`); the MCP tools are hidden and reachable only
 * through it (the way a domain host without a shell would run). A bounded wait holds
 * the first request until the bridge has connected.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("0.48.0-program"); process.exit(0); }

const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith("--") && !["--mode", "--model"].includes(args[i - 1]));
const sessionName = positional.at(-1) ?? "program-host";
const profileName = flag("--model");

const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const { createAgent, SessionStore } = await imp("packages/runtime/dist/index.js");
const createMcpExtension = (await imp("extensions/mcp/dist/kiso-mcp.mjs")).default;
const { createProgramExtension, createPlanExtension, hideTools, connectWait } = await imp("extensions/program/dist/kiso-program.mjs");

/** PROGRAM_ARM: js (the `program` tool, default) | js-index (the same plus a signature index of the hidden tools in the system prompt) | plan (the logical-IR `plan` tool). */
const ARM = process.env.PROGRAM_ARM ?? "js";
if (!["js", "js-index", "plan"].includes(ARM)) { console.error(`host: unknown PROGRAM_ARM ${ARM}`); process.exit(2); }

const home = process.env.KISO_HOME ?? "";
const profile = profileName !== undefined ? JSON.parse(readFileSync(join(home, "config.json"), "utf8")).models?.[profileName] : undefined;
const baseUrl = profile?.baseUrl ?? process.env.OPENAI_BASE_URL;
const model = profile?.model ?? process.env.OPENAI_MODEL;
const headers = Object.fromEntries(Object.entries(profile?.headers ?? {}).map(([k, v]) => [k, String(v).replace("{session}", sessionName)]));
if (!baseUrl || !model || !process.env.OPENAI_API_KEY) { console.error("host: missing baseUrl, model or OPENAI_API_KEY"); process.exit(2); }

let servers = {};
try { servers = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8")).mcpServers ?? {}; } catch { /* no servers */ }
const bridge = await createMcpExtension({ servers });


/**
 * Effects of the mock studio server's tools, declared BY THE HOST (never read from a name or a
 * description). Assumptions a real host would own: credit charges commute while the budget is
 * sufficient (the tasks' budgets are), ids are opaque. Anything not listed is `unknown` = barrier.
 */
const studioEffects = (tool, args) => {
	const t = tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
	const a = args !== null && typeof args === "object" && !Array.isArray(args) ? args : undefined;
	const key = (k, field) => (a && a[field] !== undefined ? [`${k}:${String(a[field])}`] : "*");
	switch (t) {
		case "create_project": return { kind: "write", keys: ["projects"] };
		case "add_subject": return { kind: "write", keys: key("project", "project_id") };
		case "generate_asset": return { kind: "write", keys: key("subject", "subject_id") };
		case "revise_asset": return { kind: "write", keys: key("asset", "asset_id") };
		case "analyze_asset": case "get_asset": return { kind: "read", keys: key("asset", "asset_id") };
		case "list_subjects": case "list_assets": case "get_subject": case "wallet_balance": return { kind: "read", keys: "*" };
		case "arrange_board": case "request_approval": case "finalize_project": return { kind: "write", keys: key("project", "project_id") };
		default: return { kind: "unknown" };
	}
};

/** The signature index: one line per tool, name(params) - first sentence. Built from the connected bridge, so it is exactly what searchTools would find. */
function signatureIndex(tools) {
	const ty = (p) => (p.enum ? p.enum.map((e) => JSON.stringify(e)).join("|") : p.type === "array" ? `${p.items?.type ?? "any"}[]` : (p.type ?? "any"));
	return tools.map((t) => {
		const props = t.inputSchema?.properties ?? {}, req = new Set(t.inputSchema?.required ?? []);
		const params = Object.entries(props).map(([k, p]) => `${k}${req.has(k) ? "" : "?"}: ${ty(p)}`).join(", ");
		const first = String(t.description ?? "").split(/(?<=[.!?])\s/)[0].slice(0, 140);
		return `${t.name}(${params}) - ${first}`;
	}).join("\n");
}

/**
 * The system prompt. PROGRAM_PROMPT=minimal reproduces the first benchmark's one-line prompt
 * (which was NOT kiso's: the 2026-10-10 op round used it and its output numbers were inflated
 * by that). The default is kiso's REAL prompt (apps/cli coding-prompt.ts, imported, not copied)
 * with only the parts about coding tools replaced: the policy sentences are kept verbatim —
 * "Be concise", "never claim a change unless a tool confirmed it", the authorization paragraph,
 * "report in one or two lines". Markers are asserted so a change to the real prompt fails here
 * instead of silently diverging.
 */
async function systemPrompt(index = "") {
	if (process.env.PROGRAM_PROMPT === "minimal") return "You are an assistant that completes the user's task using the tools you are given.";
	const real = (await imp("apps/cli/dist/coding-prompt.js")).SYSTEM_PROMPT;
	const at = (marker) => { const i = real.indexOf(marker); if (i < 0) throw new Error(`host: the real prompt no longer has "${marker}"`); return i; };
	const reach = at("What you can reach:"), discipline = at("Tool discipline:"), auth = at("An authorization covers"), flow = at("Workflow:");
	const head = real.slice(0, reach).replace("You are kiso, a coding agent. You work in a workspace\ndirectory and change code with tools.", "You are kiso, an agent. You complete the user's task with tools.");
	if (head === real.slice(0, reach)) throw new Error("host: the real prompt's opening changed");
	const reachSection = ARM === "plan"
		? "What you can reach:\n- plan: declares a set of tool calls and runs them. Tools you do not see listed are reachable only through it (ALL_TOOLS and describeTool find them).\n\n"
		: `What you can reach:\n- program: runs a script that calls the other tools. Tools you do not see listed are reachable only through it (searchTools finds them).\n${ARM === "js-index" ? `\nTools reachable through program (name(parameters) - what it does):\n${index}\n` : ""}\n`;
	const disciplineSection = "Tool discipline:\n- Be careful - tools have side effects and may take time.\n- When a tool fails, read the error and adjust; do not repeat the same call blindly.\n\n";
	const authSection = real.slice(auth, flow);
	const workflow = "Workflow: understand the request, find the relevant tools, do the work, then verify the end state with a tool call.\nReport what you did in one or two lines per change.";
	void discipline;
	return head + reachSection + disciplineSection + authSection + workflow;
}

// the index needs the connected bridge (bounded wait, as connectWait does for the first request)
let index = "";
if (ARM === "js-index") {
	const until = Date.now() + 10_000;
	while (bridge.connecting === true && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
	index = signatureIndex(bridge.tools ?? []);
}
const front = ARM === "plan" ? createPlanExtension({ effects: studioEffects, mode: process.env.PLAN_MODE === "sequential" ? "sequential" : "parallel" }) : createProgramExtension();

const agent = createAgent({
	model, provider: "openai-compat", baseUrl, apiKey: process.env.OPENAI_API_KEY, ...(Object.keys(headers).length > 0 ? { headers } : {}),
	tools: [], store: new SessionStore(process.env.KISO_SESSIONS_DIR ?? join(home, "sessions")),
	systemPrompt: await systemPrompt(index),
	extensions: [front, hideTools(bridge), connectWait(bridge, 10_000)],
});
const session = await agent.session({ id: sessionName });

const rl = createInterface({ input: process.stdin });
for await (const raw of rl) {
	const line = raw.trim();
	if (line === "" || line.startsWith("/")) continue; // slash commands are the CLI's, not ours
	for await (const ev of session.run(line)) if (ev.type === "terminal") break;
}
await bridge.dispose?.();
process.exit(0);
