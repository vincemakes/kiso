/**
 * PH-1a.1 — the Tool Schema Closed World gate (finding PH-F25).
 *
 * JSON Schema's DEFAULT is an open world: unknown properties validate.
 * Every first-party tool schema used to ride that default, so a model
 * inventing a parameter (`{path: "x", requireUnique: true}`) sailed
 * through validation and the handler silently ignored it — the model
 * believes in semantics that never executed. The kernel's rejection
 * channel already exists (loop.ts: a schema failure is a model-visible
 * `invalid_input`), so closing the schemas is the whole fix — zero core
 * lines.
 *
 * Two gates:
 *  1. INVENTED-FIELD FIXTURES — for every first-party tool, a valid
 *     input plus one invented field must FAIL validation (root and
 *     nested object nodes alike).
 *  2. SCHEMA INVENTORY — every object node in every first-party tool
 *     schema must DECLARE its world explicitly (additionalProperties
 *     present, open or closed) — a new tool that forgets goes red here.
 *
 * External MCP schemas are deliberately NOT covered: the bridge passes
 * third-party contracts through verbatim (rewriting them is not ours to
 * do); only the bridge's own first-party tools (mcp__status) are held
 * to the closed world.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateArgs } from "../packages/core/src/tools/validate.js";
import { createCodingTools } from "../packages/tools-node/src/index.js";
import { statusTool } from "../extensions/mcp/src/status.js";
// @ts-expect-error — plain .mjs extension modules carry no type declarations
import createTaskExtension from "../extensions/task/src/kiso-task.mjs";
// @ts-expect-error — same
import createSubagentExtension from "../extensions/subagent/src/kiso-subagent.mjs";
// @ts-expect-error — same
import createSkillsExtension from "../extensions/skills/src/kiso-skills.mjs";
// @ts-expect-error — same
import createAskExtension from "../extensions/ask/src/kiso-ask.mjs";

interface NamedSchema {
	readonly tool: string;
	readonly schema: Readonly<Record<string, unknown>>;
}

/** Every first-party tool's (name, parameters), gathered from the REAL
 *  factories — the gate covers what ships, not a hand-copied list. */
async function firstPartySchemas(): Promise<NamedSchema[]> {
	const ws = mkdtempSync(join(tmpdir(), "kiso-schema-gate-"));
	const tools: { name: string; parameters: Readonly<Record<string, unknown>> }[] = [
		...createCodingTools({ workspaceRoot: ws }).map((t) => ({ name: t.name, parameters: t.parameters })),
		statusTool([]) as unknown as { name: string; parameters: Readonly<Record<string, unknown>> },
	];
	const task = createTaskExtension();
	for (const t of task.tools ?? []) tools.push(t);
	const prevDepth = process.env.KISO_SUBAGENT_DEPTH;
	delete process.env.KISO_SUBAGENT_DEPTH; // depth 0 — the delegate tool exists
	const sub = await createSubagentExtension();
	if (prevDepth !== undefined) process.env.KISO_SUBAGENT_DEPTH = prevDepth;
	for (const t of sub.tools ?? []) tools.push(t);
	// skills: one fixture skill so read_skill materializes
	const skillsDir = join(ws, "skills");
	mkdirSync(join(skillsDir, "demo"), { recursive: true });
	writeFileSync(join(skillsDir, "demo", "SKILL.md"), "---\nname: demo\ndescription: a fixture skill\n---\nbody\n", "utf8");
	const prevSkills = process.env.KISO_SKILLS_DIR;
	process.env.KISO_SKILLS_DIR = skillsDir;
	const skills = await createSkillsExtension();
	if (prevSkills === undefined) delete process.env.KISO_SKILLS_DIR;
	else process.env.KISO_SKILLS_DIR = prevSkills;
	for (const t of skills.tools ?? []) tools.push(t);
	const ask = await createAskExtension({ ask: async () => ({ answers: [] }) });
	for (const t of ask.tools ?? []) tools.push(t);
	return tools.map((t) => ({ tool: t.name, schema: t.parameters }));
}

/** A minimal VALID input per tool — the invented-field probe rides it. */
const VALID_INPUTS: Readonly<Record<string, Record<string, unknown>>> = {
	read_file: { path: "a.txt" },
	list_dir: {},
	search_text: { pattern: "x" },
	write_file: { path: "a.txt", content: "hi", expectedRevision: "absent" },
	edit_file: { path: "a.txt", search: "a", replace: "b", expectedRevision: "rev:x" },
	shell: { command: "true" },
	mcp__status: {},
	task_set: { items: [{ text: "t", status: "pending" }] },
	delegate: { tasks: [{ role: "explorer", task: "look around" }] },
	read_skill: { name: "demo" },
	ask_user: { questions: [{ question: "pick one", options: [{ label: "a" }, { label: "b" }] }] },
};

/** Nested probes: the invented field sits INSIDE an array-item object. */
const NESTED_PROBES: Readonly<Record<string, Record<string, unknown>>> = {
	edit_file: { path: "a.txt", expectedRevision: "rev:x", edits: [{ search: "a", replace: "b", __invented: 1 }] },
	task_set: { items: [{ text: "t", status: "pending", __invented: 1 }] },
	delegate: { tasks: [{ role: "explorer", task: "x", __invented: 1 }] },
};

function* objectNodes(node: unknown, path: string): Generator<{ path: string; node: Record<string, unknown> }> {
	if (node === null || typeof node !== "object" || Array.isArray(node)) return;
	const o = node as Record<string, unknown>;
	const isObjectSchema = o.type === "object" || o.properties !== undefined;
	if (isObjectSchema) yield { path, node: o };
	if (o.properties !== null && typeof o.properties === "object") {
		for (const [k, v] of Object.entries(o.properties as Record<string, unknown>)) yield* objectNodes(v, `${path}.properties.${k}`);
	}
	if (o.items !== undefined) yield* objectNodes(o.items, `${path}.items`);
	for (const comb of ["anyOf", "oneOf", "allOf"] as const) {
		const arr = o[comb];
		if (Array.isArray(arr)) for (let i = 0; i < arr.length; i++) yield* objectNodes(arr[i], `${path}.${comb}[${i}]`);
	}
}

describe("PH-1a.1 — the closed world (finding PH-F25)", () => {
	it("an invented ROOT field fails validation on every first-party tool, model-visibly", async () => {
		const schemas = await firstPartySchemas();
		expect(schemas.length).toBeGreaterThanOrEqual(11); // 6 built-ins + status + task_set + delegate + read_skill + ask_user
		for (const { tool, schema } of schemas) {
			const valid = VALID_INPUTS[tool];
			expect(valid, `no VALID_INPUTS fixture for tool "${tool}" — add one (a new first-party tool joins this gate)`).toBeDefined();
			expect(validateArgs(schema, valid!), `the valid fixture for "${tool}" must pass`).toBeNull();
			const err = validateArgs(schema, { ...valid, __invented: 1 });
			expect(err, `"${tool}" accepted an invented root field — the schema is an open world`).not.toBeNull();
			expect(err).toMatch(/additional propert/i);
		}
	});

	it("an invented NESTED field fails too — the closed world covers array-item objects", async () => {
		const schemas = new Map((await firstPartySchemas()).map((s) => [s.tool, s.schema]));
		for (const [tool, probe] of Object.entries(NESTED_PROBES)) {
			const err = validateArgs(schemas.get(tool)!, probe);
			expect(err, `"${tool}" accepted an invented field inside a nested object`).not.toBeNull();
			expect(err).toMatch(/additional propert/i);
		}
	});

	it("SCHEMA INVENTORY — every first-party object node declares its world explicitly", async () => {
		const missing: string[] = [];
		for (const { tool, schema } of await firstPartySchemas()) {
			for (const { path, node } of objectNodes(schema, tool)) {
				if (!Object.hasOwn(node, "additionalProperties")) missing.push(path);
			}
		}
		expect(missing, `object nodes with NO explicit additionalProperties declaration:\n  ${missing.join("\n  ")}`).toEqual([]);
	});
});
