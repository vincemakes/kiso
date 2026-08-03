#!/usr/bin/env node
/**
 * Consumer smoke test — the publish pipeline's last gate (Area 7).
 *
 * THREE ISOLATED tiers, each a clean temp project installing only the
 * closure it needs (never all seven preinstalled, which would mask missing
 * dependencies):
 *
 *   tier A — runtime:  core + evals + runtime + tools-node
 *                       runs a durable session, an approval pause/resume,
 *                       and the README example verbatim
 *   tier B — providers: core + provider-anthropic + provider-openai
 *                       imports both factories (SDKs resolve from npm)
 *   tier C — cli:       the CLI's full dependency closure
 *                       runs the installed `kiso` bin (sessions listing)
 *
 * Tarball names come from `npm pack --json`, never hardcoded versions.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const ALL = {
	"@kiso/core": true,
	"@kiso/evals": true,
	"@kiso/runtime": true,
	"@kiso/tools-node": true,
	"@kiso/provider-anthropic": true,
	"@kiso/provider-openai": true,
	"@kiso/cli": true,
};

/** Pack a package and return the REAL tarball filename from npm's JSON. */
function pack(stage, name) {
	const out = execSync(`npm pack --json -w ${name} --pack-destination ${stage}`, { cwd: ROOT, encoding: "utf8" });
	const parsed = JSON.parse(out.slice(out.indexOf("[")));
	const file = parsed[0]?.filename;
	if (!file) throw new Error(`npm pack gave no filename for ${name}:\n${out}`);
	return join(stage, file);
}

function tempProject(label) {
	const proj = mkdtempSync(join(tmpdir(), `kiso-${label}-`));
	writeFileSync(join(proj, "package.json"), JSON.stringify({ name: `kiso-${label}`, private: true, type: "module" }, null, 2));
	console.log(`[smoke:${label}] clean project at ${proj}`);
	return proj;
}

/** Install the given packages (in dependency order) into a clean project. */
function installTier(label, names, proj) {
	const stage = mkdtempSync(join(tmpdir(), `kiso-pack-${label}-`));
	const tarballs = names.map((n) => pack(stage, n));
	for (const tarball of tarballs) {
		execSync(`npm install --no-audit --no-fund --no-package-lock "${tarball}"`, { cwd: proj, stdio: "inherit" });
	}
	rmSync(stage, { recursive: true, force: true });
	return tarballs.length;
}

// ── tier A: the runtime closure ────────────────────────────────────────
{
	const proj = tempProject("runtime");
	installTier("runtime", ["@kiso/core", "@kiso/evals", "@kiso/runtime", "@kiso/tools-node"], proj);
	writeFileSync(
		join(proj, "smoke.mjs"),
		`import { defineTool, ToolRegistry, loop, mapApiError } from "@kiso/core";
import { createFauxProvider } from "@kiso/evals";
import { createAgent, SessionStore } from "@kiso/runtime";
import { readFileTool } from "@kiso/tools-node";

// 1. the raw loop
const registry = new ToolRegistry();
registry.register(defineTool({
  name: "add",
  description: "Add two numbers",
  parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
  execute: async ({ a, b }) => ({ content: String(a + b), isError: false }),
}));
const events = [];
for await (const ev of loop({
  adapter: createFauxProvider([
    { events: [{ type: "tool_call_end", callId: "c1", name: "add", input: { a: 2, b: 3 } }, { type: "stop", reason: "tool_use" }] },
    { events: [{ type: "stop", reason: "end_turn" }] },
  ]),
  model: "faux",
  registry,
  messages: [{ role: "user", content: "What is 2+3?" }],
})) events.push(ev);
const terminal = events.filter((e) => e.type === "terminal").at(-1);
if (terminal?.outcome?.kind !== "completed") throw new Error("expected completed terminal, got " + JSON.stringify(terminal?.outcome));
if (!events.some((e) => e.type === "tool_result" && e.content === "5")) throw new Error("tool result missing");

// 2. the runtime: a durable session with an approval pause
const store = new SessionStore(new URL("./sessions/", import.meta.url).pathname);
const agent = createAgent({
  model: "faux",
  store,
  tools: [defineTool({ name: "add", description: "Add", parameters: { type: "object" }, execute: async ({ a, b }) => ({ content: String(a + b), isError: false }) }), readFileTool({ workspaceRoot: "." })],
  adapter: createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]),
});
const session = await agent.session({ id: "smoke" });
for await (const ev of session.run("1+1?")) { /* drain */ }
const reloaded = await agent.session({ id: "smoke" });
if (!reloaded.projected().some((m) => m.role === "user")) throw new Error("session did not survive reload");

// 3. approval pause: defer -> paused -> approve -> same run resumes
const guarded = createAgent({
  model: "faux",
  store,
  tools: [defineTool({ name: "write_file", description: "Write", parameters: { type: "object" }, execute: async () => ({ content: "written", isError: false }) })],
  adapter: createFauxProvider([
    { events: [{ type: "tool_call_end", callId: "w1", name: "write_file", input: { path: "x" } }, { type: "stop", reason: "tool_use" }] },
    { events: [{ type: "stop", reason: "end_turn" }] },
  ]),
  permissionPolicy: { rules: [{ tool: "write_file", action: "defer" }] },
});
const gs = await guarded.session({ id: "guarded" });
let paused = false;
let executed = false;
for await (const ev of gs.run("write x")) {
  if (ev.type === "permission_requested") { paused = true; gs.approve(ev.decisionId, true); }
  if (ev.type === "tool_execution_succeeded") executed = true;
}
if (!paused || !executed) throw new Error("approval pause/resume broken");

if (mapApiError(429, "x").code !== "rate_limit") throw new Error("mapApiError broken");
console.log("tier A OK — runtime closure: loop + durable session + approval pause/resume");
`,
	);
	execSync("node smoke.mjs", { cwd: proj, stdio: "inherit" });

	// The README example, verbatim, runs in the same clean project.
	execSync(`cp ${JSON.stringify(join(ROOT, "examples", "hello-agent.mjs"))} hello-agent.mjs`, { cwd: proj });
	const hello = execSync("node hello-agent.mjs", { cwd: proj, encoding: "utf8" });
	if (!hello.includes("completed")) throw new Error(`README example failed:\n${hello}`);
	console.log("[smoke:runtime] README example ran in the clean project");

	// A strict TypeScript consumer compiles against the installed .d.ts.
	execSync("npm install --no-audit --no-fund --no-package-lock typescript@^5.7.2 @types/node@^26.1.2", { cwd: proj, stdio: "inherit" });
	writeFileSync(
		join(proj, "check-types.ts"),
		`import { createAgent, SessionStore } from "@kiso/runtime";
import { defineTool, loop, type Event } from "@kiso/core";
import { createFauxProvider, FIXTURES } from "@kiso/evals";
import { readFileTool, shellTool } from "@kiso/tools-node";
const agent = createAgent({ model: "m", tools: [readFileTool({ workspaceRoot: "." }), shellTool({ workspaceRoot: "." })], store: new SessionStore("./s"), adapter: createFauxProvider([]) });
const ev: Event | undefined = undefined;
void agent; void defineTool; void loop; void ev; void FIXTURES;
`,
	);
	writeFileSync(
		join(proj, "tsconfig.json"),
		JSON.stringify(
			{ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true, target: "ES2022", types: ["node"] }, include: ["check-types.ts"] },
			null,
			2,
		),
	);
	execSync("./node_modules/.bin/tsc -p tsconfig.json", { cwd: proj, stdio: "inherit" });
	console.log("[smoke:runtime] TS consumer compiled against installed .d.ts");
	rmSync(proj, { recursive: true, force: true });
}

// ── tier A2: NESTED install strategy (pnpm-style, no npm flattening) ──
// A nested node_modules layout must resolve the same way — missing
// intra-kiso deps cannot hide behind a flattened root (F 组).
{
	const proj = tempProject("nested");
	const stage = mkdtempSync(join(tmpdir(), "kiso-pack-nested-"));
	const tarballs = ["@kiso/core", "@kiso/evals", "@kiso/runtime", "@kiso/tools-node"].map((n) => pack(stage, n));
	for (const tarball of tarballs) {
		execSync(`npm install --install-strategy=nested --no-audit --no-fund --no-package-lock "${tarball}"`, {
			cwd: proj,
			stdio: "inherit",
		});
	}
	rmSync(stage, { recursive: true, force: true });
	writeFileSync(
		join(proj, "nested.mjs"),
		`import { createAgent, SessionStore } from "@kiso/runtime";
import { createFauxProvider } from "@kiso/evals";
const store = new SessionStore("./s");
const agent = createAgent({
  model: "faux",
  store,
  tools: [],
  adapter: createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]),
});
const session = await agent.session({ id: "n" });
for await (const _ev of session.run("hi")) { /* drain */ }
if (!(await agent.session({ id: "n" })).projected().some((m) => m.role === "user")) throw new Error("nested install broken");
console.log("tier A2 OK — nested install resolves the runtime closure");
`,
	);
	execSync("node nested.mjs", { cwd: proj, stdio: "inherit" });
	rmSync(proj, { recursive: true, force: true });
}

// ── tier B: the provider closure ───────────────────────────────────────
{
	const proj = tempProject("providers");
	installTier("providers", ["@kiso/core", "@kiso/provider-anthropic", "@kiso/provider-openai"], proj);
	writeFileSync(
		join(proj, "providers.mjs"),
		`import { createAnthropicAdapter } from "@kiso/provider-anthropic";
import { createOpenAICompatAdapter } from "@kiso/provider-openai";
import { mapApiError } from "@kiso/core";
if (typeof createAnthropicAdapter !== "function" || typeof createOpenAICompatAdapter !== "function") throw new Error("adapter factories missing");
if (mapApiError(529, "x").code !== "overloaded") throw new Error("error mapping broken");
console.log("tier B OK — provider closure: both factories import, error mapping works");
`,
	);
	execSync("node providers.mjs", { cwd: proj, stdio: "inherit" });
	rmSync(proj, { recursive: true, force: true });
}

// ── tier C: the CLI's full dependency closure ──────────────────────────
{
	const proj = tempProject("cli");
	installTier(
		"cli",
		["@kiso/core", "@kiso/evals", "@kiso/runtime", "@kiso/tools-node", "@kiso/provider-anthropic", "@kiso/provider-openai", "@kiso/cli"],
		proj,
	);
	// The smoke program above created sessions in ITS project; here we create
	// one via the installed bin itself, then list it.
	execSync(`KISO_HOME=${proj} npx kiso sessions`, { cwd: proj, stdio: "inherit" });
	// A full faux chat turn through the installed CLI bin.
	const chat = execSync(`printf 'hello\\nexit\\n' | KISO_HOME=${proj} npx kiso chat cli-smoke`, { cwd: proj, encoding: "utf8" });
	if (!chat.includes("faux model")) throw new Error(`kiso chat did not run:\n${chat}`);
	const sessions = execSync(`KISO_HOME=${proj} npx kiso sessions`, { cwd: proj, encoding: "utf8" });
	if (!sessions.includes("cli-smoke")) throw new Error(`kiso sessions did not list cli-smoke:\n${sessions}`);
	console.log("[smoke:cli] installed kiso bin runs chat + sessions on its closure");
	rmSync(proj, { recursive: true, force: true });
}

console.log("\n[smoke] PASS — 4 isolated consumer tiers (runtime, nested, providers, CLI) on packed artifacts");
