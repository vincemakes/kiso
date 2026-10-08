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
 * E3 (0.2.1): the script becomes the rent ledger's PREDICTION side (R7,
 * the star). The composition the CLI actually builds — the built-in
 * prompt, the coding tools, and the three default built-in extensions
 * (mcp / skills / subagent; the task extension left at E5 and was
 * retired in 0.44.0) — is
 * exposed as `defaultCompositionParts`;
 * `predictDefaultRentLedger` turns those parts into the exact ledger
 * array the runtime records, and `--rent-ledger` prints the table the
 * release report carries. The R7 gate (rent-ledger-gate.test.ts) asserts
 * script prediction == runtime record on a REAL session — the table is
 * machine-proven, never transcribed. A {home} pins KISO_HOME around the
 * extension factories, so the prediction is the UNCONFIGURED composition
 * (bare home: no skills dir, no MCP config — the bench shape).
 *
 * Usage:
 *   node scripts/request-surface.mjs                — the diet-A counting
 *   node scripts/request-surface.mjs --rent-ledger [model]
 *        — the E3 ledger table (bare home unless KISO_HOME is set)
 *
 * The API-NAME surface enumerator (the pre-adjudication diet B) lives
 * beside this as api-surface.mjs — the token rent and the name surface
 * are different measurements, both kept.
 */

import { createRequire } from "node:module";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(fileURLToPath(new URL(".", import.meta.url)));

// The CLI dist — importing it is safe: main() is guarded by the argv[1]
// comparison (index.ts tail). The export exists for this script.
const { SYSTEM_PROMPT, CODING_TOOL_RULES } = require("../apps/cli/dist/index.js");
const { createCodingTools } = require("@vincemakes/kiso-tools-node");
// The runtime's SINGLE source — the script predicts with the real built
// module, never a copy (the same dist the release publishes).
const { buildRentLedger } = await import("../packages/runtime/dist/trace/rent.js");
// RG-F2: the generated table, by the runtime's own function
const { composeToolTable } = await import("../packages/runtime/dist/compose.js");
const { ToolRegistry } = await import("@vincemakes/kiso-core");

/** The default bench composition — exactly what the CLI builds for an
 *  unconfigured home: the built-in system prompt, the coding tools, and
 *  the three default built-in extensions in load order
 *  (apps/cli/src/builtin.ts). E5: the task extension left the default —
 *  measured dead weight (E5-F1/F2); the prediction mirrors the default
 *  WITHOUT it (the rent-ledger gate proves prediction == record).
 *  {home} pins KISO_HOME around the extension factories (the mcp and
 *  skills extensions read it at instantiation), so the parts describe
 *  the UNCONFIGURED session — the shape the bench rounds measure. */
export async function defaultCompositionParts({ home } = {}) {
	const previous = process.env.KISO_HOME;
	if (home !== undefined) process.env.KISO_HOME = home;
	try {
		const [mcp, skills, subagent] = await Promise.all([
			import("@vincemakes/kiso-mcp-ext").then((m) => m.default()),
			import("@vincemakes/kiso-skills-ext").then((m) => m.default()),
			// RG-F1, the same defect one package over: the CLI hands the subagent
			// extension the session's tasks (builtin.ts), which adds `background`
			// to delegate's schema (271 chars the prediction missed)
			import("@vincemakes/kiso-subagent-ext").then((m) => m.default({ tasks: () => undefined })),
		]);
		return {
			base: SYSTEM_PROMPT,
			// RG-F1: the CLI hands the coding tools a session's tasks
			// (apps/cli/src/state.ts codingToolOptions, `tasks: tasksFor`), and
			// their PRESENCE is what shapes the table: the shell gains its task
			// parameters, task_stop and wait join (tools-node createCodingTools).
			// The stub answers no task question — only the shape is read here.
			tools: createCodingTools({ workspaceRoot: process.cwd(), tasks: () => undefined }),
			toolRules: CODING_TOOL_RULES,
			extensions: [mcp, skills, subagent],
		};
	} finally {
		if (previous === undefined) delete process.env.KISO_HOME;
		else process.env.KISO_HOME = previous;
	}
}

/** The R7 prediction: the rent ledger for the default composition under
 *  the given model — the exact array the R7 gate asserts a real session
 *  records. The tool registry mirrors agent.ts's build (static base
 *  tools, then per-extension static + live sources) so the tool lines
 *  are the SAME toSpecs() projection in the SAME order. */
export async function predictDefaultRentLedger(model, { home } = {}) {
	const parts = await defaultCompositionParts({ home });
	const registry = new ToolRegistry();
	for (const tool of parts.tools) registry.register(tool);
	for (const ext of parts.extensions) {
		for (const tool of ext.tools ?? []) registry.register(tool);
		registry.registerLive(() => ext.tools ?? []);
	}
	const table = composeToolTable(registry, parts.toolRules);
	return buildRentLedger({
		model,
		base: parts.base,
		...(table !== "" ? { table } : {}),
		appends: parts.extensions.flatMap((e) =>
			e.systemPrompt?.append === undefined ? [] : [{ name: e.name, text: e.systemPrompt.append }],
		),
		tools: registry.toSpecs(),
	});
}

/**
 * TUI2-R3v2 ③ — the SIDE-QUERY rent arm (the safer-options seam,
 * adjudicated 2026-08-18).
 *
 * A side query is not a run request and does not pay a run request's
 * rent, so predicting it with the default arm would be wrong in the
 * expensive direction — by the entire tool table. Its composition is
 * declared here, in full, and it is deliberately the smallest a request
 * can be:
 *
 *   system:base   the side query's OWN system prompt — a few lines
 *                 asking for alternatives — NEVER the session's base
 *                 prompt, which it does not send;
 *   envelope      the R5 skeleton, a function of the model string;
 *   (nothing else) no extension appends, because a side query composes
 *                 no extensions; and NO tool lines, because it offers
 *                 no tools at all — it cannot call anything, it can
 *                 only answer.
 *
 * That absence IS the ledger statement (R9, the not-paid-no-rent
 * precedent): the side query's whole claim to being affordable is that
 * it skips the surface a run request cannot.
 *
 * AMENDED by finding R3v2-F1 (2026-08-18). The declared composition is
 * unchanged in KIND — still one system prompt, still no appends, still
 * no tools — and this function is unchanged in behaviour, because the
 * ledger is computed FROM the prompt it is handed and so stays exact
 * whatever the caller sends. Two facts about that caller moved, and the
 * declaration records them:
 *
 *   - the system prompt is now a FIRM format contract (JSON only, the
 *     exact schema, no prose) rather than a request for JSON. It is a
 *     few lines longer; its rent is still the single base line, and the
 *     line is still measured, not assumed.
 *   - the output ceiling rose 500 → 1500. It is NOT rent and does not
 *     appear in this ledger: the ledger prices what a request SENDS,
 *     and a ceiling prices nothing until tokens are generated. It is
 *     declared here anyway because the 500 was a live defect — the cap
 *     truncated the reply mid-JSON, so the parser could never succeed —
 *     and a number that could break a feature belongs in the record
 *     next to the prompt it bounds.
 *
 * The zero-ambient-rent claim is untouched: the query still fires only
 * on a press, so an unpressed session's ledger for this arm is empty.
 */
export function predictSideQueryRentLedger(model, systemPrompt) {
	return buildRentLedger({ model, base: systemPrompt });
}

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

/** The diet-A counting (the pre-E3 script, unchanged in meaning): the
 *  built-in prompt + the six coding tools, the static per-request total,
 *  and the measured mcp__status saving. */
function printDietA() {
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
}

/** The E3 ledger table — the release report's artifact. A bare home is
 *  used unless the caller exported KISO_HOME (their own composition
 *  wins over the unconfigured shape). */
async function printRentLedger(model) {
	const home = process.env.KISO_HOME === undefined ? mkdtempSync(join(tmpdir(), "kiso-rent-table-")) : undefined;
	const lines = await predictDefaultRentLedger(model, { home });
	console.log(`the E3 rent ledger — default bench composition, model "${model}":`);
	for (const l of lines) {
		console.log(`  ${l.surface.padEnd(24)} ${String(l.chars).padStart(5)} chars / ${String(l.estTokens).padStart(4)} est. tokens`);
	}
	const totalChars = lines.reduce((s, l) => s + l.chars, 0);
	const totalTokens = lines.reduce((s, l) => s + l.estTokens, 0);
	console.log(`  ${"total".padEnd(24)} ${String(totalChars).padStart(5)} chars / ${String(totalTokens).padStart(4)} est. tokens`);
}

/**
 * Plan A (rev 2) — the static-surface RATCHET. The snapshot is the
 * committed truth of the default composition's static rent, line by line;
 * `--check` fails on ANY difference, either way:
 *
 *   - a line grew or appeared: growth needs `--snapshot --ruling <file>`,
 *     which records the ruling in the snapshot's history (the owner's
 *     approval, by name, in the diff a reviewer reads);
 *   - a line shrank or vanished: `--snapshot` records the ratchet step,
 *     so the snapshot is never a stale ceiling that would let the next
 *     PR grow back into the room a diet freed.
 *
 * No absolute target (the owner's ruling, 2026-10-07): the number only
 * moves down, or up by a named ruling. POSIX composition (the shell's
 * description names its shell); `npm run check` is POSIX-only.
 */
const SNAPSHOT = new URL("./rent-snapshot.json", import.meta.url);
const SNAPSHOT_MODEL = "deepseek-chat";

async function currentLines() {
	const home = mkdtempSync(join(tmpdir(), "kiso-rent-gate-"));
	return (await predictDefaultRentLedger(SNAPSHOT_MODEL, { home })).map((l) => ({ surface: l.surface, chars: l.chars }));
}

/** Per-surface differences between two line lists (both directions). */
export function diffLines(before, after) {
	const was = new Map(before.map((l) => [l.surface, l.chars]));
	const now = new Map(after.map((l) => [l.surface, l.chars]));
	const out = [];
	for (const [surface, chars] of now) {
		const prior = was.get(surface);
		if (prior === undefined) out.push({ surface, from: null, to: chars, kind: "appeared" });
		else if (chars > prior) out.push({ surface, from: prior, to: chars, kind: "grew" });
		else if (chars < prior) out.push({ surface, from: prior, to: chars, kind: "shrank" });
	}
	for (const [surface, chars] of was) if (!now.has(surface)) out.push({ surface, from: chars, to: null, kind: "vanished" });
	return out;
}

const totalOf = (lines) => ({ chars: lines.reduce((a, l) => a + l.chars, 0), estTokens: lines.reduce((a, l) => a + Math.ceil(l.chars / 4), 0) });

async function checkSnapshot() {
	let snap;
	try {
		snap = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
	} catch (err) {
		console.error(`[rent-gate] cannot read ${fileURLToPath(SNAPSHOT)}: ${err.message}`);
		process.exit(1);
	}
	const lines = await currentLines();
	const diffs = diffLines(snap.lines, lines);
	const total = totalOf(lines);
	if (diffs.length === 0) {
		console.log(`[rent-gate] the default composition's static rent: ${total.chars} chars / ${total.estTokens} est. tokens — equal to the snapshot, line for line`);
		return;
	}
	console.error(`[rent-gate] the static rent differs from scripts/rent-snapshot.json:`);
	for (const d of diffs) console.error(`  ${d.kind.padEnd(8)} ${d.surface.padEnd(24)} ${d.from ?? "-"} -> ${d.to ?? "-"} chars`);
	const grown = diffs.some((d) => d.kind === "grew" || d.kind === "appeared");
	console.error(
		grown
			? `  a growth is recorded only with a ruling: node scripts/request-surface.mjs --snapshot --ruling <kiso-doc file>`
			: `  a shrink is a ratchet step: record it with node scripts/request-surface.mjs --snapshot`,
	);
	process.exit(1);
}

async function writeSnapshot(ruling) {
	let prior = null;
	try {
		prior = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
	} catch {
		/* the first snapshot */
	}
	const lines = await currentLines();
	const diffs = prior === null ? [] : diffLines(prior.lines, lines);
	const grown = diffs.filter((d) => d.kind === "grew" || d.kind === "appeared");
	if (grown.length > 0 && ruling === undefined) {
		console.error(`[rent-gate] refused: these lines grew, and a growth needs --ruling <kiso-doc file>:`);
		for (const d of grown) console.error(`  ${d.surface}: ${d.from ?? "-"} -> ${d.to}`);
		process.exit(1);
	}
	const total = totalOf(lines);
	const step = {
		date: new Date().toISOString().slice(0, 10),
		chars: total.chars,
		estTokens: total.estTokens,
		why: ruling ?? (prior === null ? "the first snapshot" : diffs.length === 0 ? "unchanged" : "a ratchet step (shrink only)"),
	};
	const out = {
		model: SNAPSHOT_MODEL,
		composition: "the default composition: built-in prompt, coding tools with tasks, the three default extensions, bare home, no project instructions; POSIX",
		lines,
		total,
		history: [...(prior?.history ?? []), step],
	};
	writeFileSync(SNAPSHOT, JSON.stringify(out, null, "\t") + "\n");
	console.log(`[rent-gate] snapshot written: ${total.chars} chars / ${total.estTokens} est. tokens (${step.why})`);
}

async function main() {
	if (process.argv[2] === "--rent-ledger") {
		await printRentLedger(process.argv[3] ?? "deepseek-chat");
		return;
	}
	if (process.argv[2] === "--check") return checkSnapshot();
	if (process.argv[2] === "--snapshot") {
		const i = process.argv.indexOf("--ruling");
		return writeSnapshot(i > 0 ? process.argv[i + 1] : undefined);
	}
	printDietA();
}

// The CLI's main-guard pattern (realpath handles npx's symlink).
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
