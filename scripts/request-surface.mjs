#!/usr/bin/env node
/**
 * R-G 0.1.48 (diet B, re-made as adjudicated): the model-side token-rent
 * counter.
 *
 * Every model request pays a static rent: the system prompt plus every
 * tool's serialized spec ({name, description, inputSchema} — the ToolSpec
 * projection of protocol/messages.ts, what the adapters actually send).
 * This script counts that rent for the DEFAULT session composition — the
 * built-in system prompt, no project instructions, no extensions, no
 * modes (the unconfigured bench session the rounds measure) — and prints:
 *
 *   - the system prompt: chars + estimated tokens
 *   - each tool of the composition: its serialized spec's chars + tokens
 *   - the static per-request total
 *   - diet A's MEASURED saving: the mcp__status spec the unconfigured
 *     session stopped paying in 0.1.45 (the extension now exposes no
 *     tools at all when unconfigured — extensions/mcp/src/index.ts:127)
 *
 * The estimate is chars/4 — the rounds' bench convention for "estimated
 * tokens" (the exact ratio depends on the tokenizer; 4 chars per token
 * is the standard rough bound). The system prompt is the REAL exported
 * constant (apps/cli/src/index.ts, exported for this script — never a
 * copy); the tools are the REAL built dist of kiso-tools-node, the same
 * module the CLI instantiates. Deterministic: same tree → same numbers.
 *
 * Usage: node scripts/request-surface.mjs
 *
 * The API-NAME surface enumerator (the pre-adjudication diet B) lives
 * beside this as api-surface.mjs — the token rent and the name surface
 * are different measurements, both kept.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(fileURLToPath(new URL(".", import.meta.url)));

// The CLI dist — importing it is safe: main() is guarded by the argv[1]
// comparison (index.ts tail). The export exists for this script.
const { SYSTEM_PROMPT } = require("../apps/cli/dist/index.js");
const { createCodingTools } = require("@vincemakes/kiso-tools-node");

/** The rent of one tool: the serialized ToolSpec the adapters send. */
function rent(tool) {
	const spec = {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters,
	};
	return JSON.stringify(spec);
}

const est = (n) => Math.ceil(n / 4);

const tools = createCodingTools({ workspaceRoot: process.cwd() });
const toolRents = tools.map((t) => ({ name: t.name, rent: rent(t) }));

const sysChars = SYSTEM_PROMPT.length;
const toolChars = toolRents.reduce((s, t) => s + t.rent.length, 0);
const totalChars = sysChars + toolChars;

console.log(`system prompt (built-in, no project instructions):`);
console.log(`  ${sysChars} chars / ${est(sysChars)} est. tokens`);
console.log(`tools (the default session composition, createCodingTools):`);
for (const { name, rent: r } of toolRents) {
	console.log(`  ${name.padEnd(24)} ${String(r.length).padStart(4)} chars / ${String(est(r.length)).padStart(3)} est. tokens`);
}
console.log(`  ${String(toolRents.length).padEnd(10)} tools`);
console.log(`static per-request total (default composition):`);
console.log(`  ${totalChars} chars / ${est(totalChars)} est. tokens`);

// diet A (0.1.45): the unconfigured session stopped carrying mcp__status.
// The spec is the extension's statusTool (extensions/mcp/src/index.ts:
// 313) — the script serializes the same projection, so the saving is
// measured, not invented.
const STATUS_RENT = JSON.stringify({
	name: "mcp__status",
	description: "list MCP server connection status",
	inputSchema: { type: "object", properties: {} },
});
console.log(`diet A measured saving (the mcp__status spec, absent since 0.1.45):`);
console.log(`  -${STATUS_RENT.length} chars / -${est(STATUS_RENT.length)} est. tokens per request`);
