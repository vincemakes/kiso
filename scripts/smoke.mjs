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
const PACKAGES = ["@kiso/core", "@kiso/evals", "@kiso/provider-anthropic", "@kiso/provider-openai"];

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
import { createAnthropicAdapter } from "@kiso/provider-anthropic";
import { createOpenAICompatAdapter } from "@kiso/provider-openai";

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
if (mapApiError(429, "x").code !== "rate_limit") throw new Error("mapApiError broken");
if (typeof createAnthropicAdapter !== "function" || typeof createOpenAICompatAdapter !== "function") throw new Error("adapter factories missing");
console.log("smoke OK — installed artifacts run a complete agent session");
`,
	);

	// 4. Run it with plain node — no tsx anywhere.
	execSync("node smoke.mjs", { cwd: proj, stdio: "inherit" });
	console.log(`\n[smoke] PASS — ${tarballs.length} tarballs installed and exercised`);
} finally {
	rmSync(stage, { recursive: true, force: true });
	rmSync(proj, { recursive: true, force: true });
}
