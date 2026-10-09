/**
 * R1 (2026-09-23) — the byte fixture: kiso-code's tool table did not move.
 *
 * The fixture (tests/fixtures/tool-table-0.40.6.txt) was captured from the
 * code BEFORE R1, when the vocabulary rows were a runtime constant, and
 * committed first. After R1 the rows come from the CLI's CODING_TOOL_RULES
 * through the same mechanism; the bytes must be the same bytes. The
 * registry here is built exactly as the capture built it — the coding
 * tools registered directly, every built-in extension's tools as a live
 * source (the agent's own registration order), no panel bridge.
 *
 * Regenerating the fixture is a prompt change and belongs to another round.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "@vincemakes/kiso-core";
import { composeToolTable } from "@vincemakes/kiso-runtime/internal";
import { createCodingTools } from "@vincemakes/kiso-tools-node";
import { builtInLayer } from "../src/builtin.js";
import { CODING_TOOL_RULES } from "../src/coding-prompt.js";

describe("R1: the coding tool table is byte-identical to its pre-R1 capture", () => {
	it("composeToolTable(registry, CODING_TOOL_RULES) === the 0.40.6 fixture", async () => {
		// Plan B: read_skill now carries an inventory line, so the skills
		// extension must see NO skills here — never the machine's own
		// ~/.kiso/skills (the bytes would follow whoever runs the test).
		const priorSkills = process.env.KISO_SKILLS_DIR;
		process.env.KISO_SKILLS_DIR = mkdtempSync(join(tmpdir(), "kiso-no-skills-"));
		const registry = new ToolRegistry();
		for (const t of createCodingTools({ workspaceRoot: "/tmp" })) registry.register(t);
		for (const ext of await builtInLayer([], [])) registry.registerLive(() => ext.tools ?? [], ext.name);
		// the file carries ONE trailing newline for the whitespace gate; the table ends without one
		const fixture = readFileSync(join(import.meta.dirname, "fixtures", "tool-table-0.40.6.txt"), "utf8").replace(/\n$/, "");
		// ADR-0061: 1435 → 1430 (oldText/newText); Plan B: 1430 → 1205 (short inventory lines, the write/edit rule once; the PR-1d shell rule and snippet stay verbatim)
		expect(Buffer.byteLength(fixture, "utf8")).toBe(1205); // bytes, not UTF-16 units: the em-dashes are three bytes each
		const table = composeToolTable(registry, CODING_TOOL_RULES);
		if (priorSkills === undefined) delete process.env.KISO_SKILLS_DIR;
		else process.env.KISO_SKILLS_DIR = priorSkills;
		expect(table).toBe(fixture);
	});
});
