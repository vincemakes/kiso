#!/usr/bin/env node
/**
 * Consumer smoke test — the publish pipeline's last gate.
 *
 * Packs every publishable package, installs the tarballs into a clean temp
 * project (no workspace, no tsx, no source access), and runs a real faux
 * agent session against the installed artifacts. If the README's promise
 * ("install the compiled package and create an agent in ~20 lines") is ever
 * broken, this is the script that breaks first.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PACKAGES = ["@kiso/core", "@kiso/evals", "@kiso/runtime", "@kiso/provider-anthropic", "@kiso/provider-openai"];

const stage = mkdtempSync(join(tmpdir(), "kiso-pack-"));
const proj = mkdtempSync(join(tmpdir(), "kiso-smoke-"));
console.log(`[smoke] packing into ${stage}\n[smoke] clean project at ${proj}`);

try {
	// 1. Pack each tarball.
	for (const name of PACKAGES) {
		execSync(`npm pack -w ${name} --pack-destination ${stage}`, { cwd: ROOT, stdio: "inherit" });
	}
	const tarballs = readdirSync(stage).filter((f) => f.endsWith(".tgz")).map((f) => join(stage, f));

	// 2. Install into a clean project — dependency order so intra-kiso deps
	//    resolve from the already-installed node_modules, never from a registry.
	writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "kiso-smoke", private: true, type: "module" }, null, 2));
	for (const tarball of tarballs) {
		execSync(`npm install --no-audit --no-fund --no-package-lock "${tarball}"`, { cwd: proj, stdio: "inherit" });
	}

	// 3. The smoke program — imports the packages as a consumer would.
	writeFileSync(
		join(proj, "smoke.mjs"),
		`import { defineTool, ToolRegistry, loop, mapApiError } from "@kiso/core";
import { createFauxProvider } from "@kiso/evals";
import { createAgent, SessionStore } from "@kiso/runtime";
import { createAnthropicAdapter } from "@kiso/provider-anthropic";
import { createOpenAICompatAdapter } from "@kiso/provider-openai";

const registry = new ToolRegistry();
registry.register(defineTool({
  name: "add",
  description: "Add two numbers",
  parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
  execute: async ({ a, b }) => ({ content: String(a + b), isError: false }),
}));

// 1. the raw loop
const events = [];
for await (const ev of loop({
  adapter: createFauxProvider([
    { events: [{ type: "tool_call_end", callId: "c1", name: "add", input: { a: 2, b: 3 } }] },
    { events: [{ type: "stop", reason: "end_turn" }] },
  ]),
  model: "faux",
  registry,
  messages: [{ role: "user", content: "What is 2+3?" }],
})) events.push(ev);
const terminal = events.filter((e) => e.type === "terminal").at(-1);
if (terminal?.outcome?.kind !== "completed") throw new Error("expected completed terminal, got " + JSON.stringify(terminal?.outcome));
if (!events.some((e) => e.type === "tool_result" && e.content === "5")) throw new Error("tool result missing");

// 2. the runtime: a durable session that survives a reload
const store = new SessionStore(new URL("./sessions/", import.meta.url).pathname);
const agent = createAgent({
  model: "faux",
  store,
  tools: [defineTool({ name: "add", description: "Add", parameters: { type: "object" }, execute: async ({ a, b }) => ({ content: String(a + b), isError: false }) })],
  adapter: createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]),
});
const session = await agent.session({ id: "smoke" });
const runEvents = [];
for await (const ev of session.run("1+1?")) runEvents.push(ev);
const t2 = runEvents.filter((e) => e.type === "terminal").at(-1);
if (t2?.outcome?.kind !== "completed") throw new Error("runtime session failed: " + JSON.stringify(t2?.outcome));
const reloaded = await agent.session({ id: "smoke" });
if (!reloaded.projected().some((m) => m.role === "user")) throw new Error("session did not survive reload");

// 3. approval pause: defer -> paused -> approve -> same run resumes
const guarded = createAgent({
  model: "faux",
  store,
  tools: [defineTool({ name: "write_file", description: "Write", parameters: { type: "object" }, execute: async () => ({ content: "written", isError: false }) })],
  adapter: createFauxProvider([
    { events: [{ type: "tool_call_end", callId: "w1", name: "write_file", input: { path: "x" } }] },
    { events: [{ type: "stop", reason: "end_turn" }] },
  ]),
  permissionPolicy: { rules: [{ tool: "write_file", action: "defer" }] },
});
const gs = await guarded.session({ id: "guarded" });
let executed = false;
let paused = false;
for await (const ev of gs.run("write x")) {
  if (ev.type === "permission_requested") {
    paused = true;
    gs.approve(ev.decisionId, true); // the human approves
  }
  if (ev.type === "tool_execution_succeeded") executed = true;
}
if (!paused) throw new Error("approval never paused the run");
if (!executed) throw new Error("approved tool never executed");
const resumed = await guarded.session({ id: "guarded" });
if (resumed.pendingApprovals().length !== 0) throw new Error("approval not durable");

if (mapApiError(429, "x").code !== "rate_limit") throw new Error("mapApiError broken");
if (typeof createAnthropicAdapter !== "function" || typeof createOpenAICompatAdapter !== "function") throw new Error("adapter factories missing");
console.log("smoke OK — loop + durable session + approval pause/resume, all on installed artifacts");
`,
	);

	// 4. Run it with plain node — no tsx anywhere.
	execSync("node smoke.mjs", { cwd: proj, stdio: "inherit" });
	console.log(`\n[smoke] PASS — ${tarballs.length} tarballs installed and exercised`);
} finally {
	rmSync(stage, { recursive: true, force: true });
	rmSync(proj, { recursive: true, force: true });
}
