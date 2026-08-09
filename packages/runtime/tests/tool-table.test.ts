/**
 * 0.1.40 (R-C item 1) — the golden test: the assembled system prompt is
 * pinned byte-for-byte. The tool substitution table comes from the ACTIVE
 * tool set (vocabulary lines filtered, per-tool snippets, guideline
 * bullets); the full descriptions never enter the prompt (the JSON schema
 * carries them). Deterministic: same base + extensions + registry → same
 * prompt.
 */

import { describe, expect, it } from "vitest";
import { defineTool, ToolRegistry } from "@vincemakes/kiso-core";
import { composeSystemPrompt, composeToolTable } from "../src/compose.js";

const BASE = "You are a coding agent.";
const EXT = { name: "e1", systemPrompt: { append: "Speak English." } };

function registryWith(tools: Parameters<ToolRegistry["register"]>[0][]): ToolRegistry {
	const registry = new ToolRegistry();
	for (const t of tools) registry.register(t);
	return registry;
}

const reader = defineTool({
	name: "read_file",
	description: "Read files (the full description lives in the schema).",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	promptSnippet: "read_file — the workspace reader",
	promptGuidelines: ["read ranges, not whole files"],
	execute: async () => ({ content: "", isError: false }),
});

const plain = defineTool({
	name: "plain_tool",
	description: "A tool without a snippet.",
	parameters: { type: "object" },
	execute: async () => ({ content: "", isError: false }),
});

describe("the tool substitution table (R-C item 1)", () => {
	it("golden: the assembled prompt is pinned byte-for-byte", () => {
		// run.ts assembly: base + table, THEN the extension appends — the
		// generated table never outranks the deliberate extension text.
		const table = composeToolTable(registryWith([reader, plain]));
		const assembled = composeSystemPrompt(`${BASE}\n\n${table}`, [EXT]);
		expect(assembled).toBe(`You are a coding agent.

Tool use:
- read files with read_file, never shell cat/head/tail
- batch independent tool calls into one reply — they run in parallel
- read_file — the workspace reader
Active tool guidelines:
- read_file: read ranges, not whole files

Speak English.`);
	});

	it("vocabulary lines are filtered to the ACTIVE tool set — no shell, no shell line", () => {
		const table = composeToolTable(registryWith([reader]));
		expect(table).toContain("read files with read_file");
		expect(table).not.toContain("reserve shell");
		expect(table).not.toContain("search with search_text");
	});

	it("a tool without a snippet contributes nothing — the description stays in the schema", () => {
		const table = composeToolTable(registryWith([plain]));
		expect(table).not.toContain("plain_tool");
		expect(table).toContain("Tool use:");
	});

	it("an empty registry yields the empty table — no vocabulary without tools", () => {
		expect(composeToolTable(new ToolRegistry())).toBe("");
	});

	it("deduped: a live source returning the same tool emits its snippet once", () => {
		const registry = new ToolRegistry();
		registry.register(reader);
		registry.registerLive(() => [reader]);
		const table = composeToolTable(registry);
		expect(table.match(/read_file — the workspace reader/g)).toHaveLength(1);
	});

	it("deterministic: same registry twice → byte-identical table", () => {
		const registry = registryWith([reader, plain]);
		expect(composeToolTable(registry)).toBe(composeToolTable(registry));
	});
});
