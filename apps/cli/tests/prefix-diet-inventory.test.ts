/**
 * Plan B (the prefix diet, rev 4 + A1) — the registry is the tool inventory.
 *
 * The "Tool use" table is generated from the tools actually registered:
 * each active tool contributes exactly one short line, and an absent tool
 * contributes none (delegate and read_skill gained theirs).
 *
 * NOT changed here: the system prompt's "What you can reach" section and
 * the shell's routing rule and snippet. They are PR-1d rows 1-3, a measured
 * combination (weather 1/5 -> 5/5) that travels together; changing them
 * needs a declared supersession and a new measurement
 * (apps/cli/tests/pr1d-clause-pins.test.ts).
 *
 * And one statement per fact: a guideline body two tools carry prints once,
 * naming both.
 */

import { describe, expect, it } from "vitest";
import { ToolRegistry, type Tool } from "@vincemakes/kiso-core";
import { composeToolTable } from "@vincemakes/kiso-runtime/internal";
import type { KisoExtension } from "@vincemakes/kiso-runtime";
import { createCodingTools } from "@vincemakes/kiso-tools-node";
import { builtInLayer } from "../src/builtin.js";
import { CODING_TOOL_RULES } from "../src/coding-prompt.js";

const ui = { ask: async () => ({ declined: [] }) };

/** The agent's own registration: coding tools directly, every extension's tools as a live source. */
function registryOf(exts: readonly KisoExtension[]): ToolRegistry {
	const r = new ToolRegistry();
	for (const t of createCodingTools({ workspaceRoot: "/tmp", tasks: {} as never })) r.register(t);
	for (const ext of exts) r.registerLive(() => ext.tools ?? [], ext.name);
	return r;
}

const inventoryLines = (table: string): string[] => table.split("\n").filter((l) => /^- [a-z_]+ — /.test(l));

describe("Plan B — the registry is the tool inventory", () => {
	it("every registered tool contributes exactly one short inventory line, and nothing else does", async () => {
		const r = registryOf(await builtInLayer([], []));
		const table = composeToolTable(r, CODING_TOOL_RULES);
		const names = r.snapshot().specs.map((s) => s.name).sort();
		const lines = inventoryLines(table);
		expect(lines.map((l) => l.slice(2, l.indexOf(" — "))).sort()).toEqual(names);
		// short lines — the shell's is PR-1d row 3, pinned verbatim, and the longest
		for (const l of lines) expect(l.length).toBeLessThanOrEqual(80);
	});

	it("a headless session has no ask_user line; an interactive one has exactly one", async () => {
		const pipe = composeToolTable(registryOf(await builtInLayer([], [])), CODING_TOOL_RULES);
		const tty = composeToolTable(registryOf(await builtInLayer([], [], ui)), CODING_TOOL_RULES);
		expect(pipe).not.toMatch(/ask_user/);
		expect(inventoryLines(tty).filter((l) => l.startsWith("- ask_user — "))).toHaveLength(1);
	});

	it("ask_user's rules live once, in its description — no guideline restates them", async () => {
		const tty = registryOf(await builtInLayer([], [], ui));
		const ask = tty.snapshot().specs.find((s) => s.name === "ask_user")!;
		expect(ask.description.length).toBeLessThanOrEqual(600);
		for (const rule of [/whether to proceed/, /authorization already given/, /sensible default/, /1-4 questions/, /2-4 exclusive options/, /\(recommended\)/, /multiSelect/, /"Other"/]) expect(ask.description).toMatch(rule);
		expect(composeToolTable(tty, CODING_TOOL_RULES)).not.toMatch(/- ask_user: /);
	});
});

describe("Plan B — one statement per fact in the guidelines", () => {
	const tool = (name: string, guidelines: string[]): Tool => ({ name, description: name, parameters: { type: "object" }, promptGuidelines: guidelines, execute: async () => ({ content: "", isError: false }) }) as unknown as Tool;

	it("a body two tools carry prints once, naming both in first-seen order; distinct bodies keep their own line", () => {
		const r = new ToolRegistry();
		r.register(tool("write_file", ["cite the revision"]));
		r.register(tool("read_file", ["read a range"]));
		r.register(tool("edit_file", ["cite the revision"]));
		const g = composeToolTable(r).split("Active tool guidelines:\n")[1]!.split("\n");
		expect(g).toEqual(["- write_file, edit_file: cite the revision", "- read_file: read a range"]);
	});

	it("the coding table prints the write/edit revision rule once", async () => {
		const table = composeToolTable(registryOf(await builtInLayer([], [])), CODING_TOOL_RULES);
		expect(table.match(/expectedRevision/g)).toHaveLength(1);
		expect(table).toMatch(/- write_file, edit_file: cite the file's latest revision/);
	});
});
