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
 *
 * Regenerated ONCE, by such a round (the committed revision witness,
 * 2026-10-08, owner-approved): the two "cite the file's latest revision"
 * guideline lines left with the citation duty — kiso binds the revision
 * now. The diff of this file is exactly those two lines (1,435 → 1,128
 * bytes); every other byte is the 0.40.6 capture's.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "@vincemakes/kiso-core";
import { composeToolTable } from "@vincemakes/kiso-runtime/internal";
import { createCodingTools } from "@vincemakes/kiso-tools-node";
import { builtInLayer } from "../src/builtin.js";
import { CODING_TOOL_RULES } from "../src/coding-prompt.js";

describe("R1: the coding tool table is byte-identical to its pre-R1 capture", () => {
	it("composeToolTable(registry, CODING_TOOL_RULES) === the 0.40.6 fixture", async () => {
		const registry = new ToolRegistry();
		for (const t of createCodingTools({ workspaceRoot: "/tmp" })) registry.register(t);
		for (const ext of await builtInLayer([], [])) registry.registerLive(() => ext.tools ?? [], ext.name);
		// the file carries ONE trailing newline for the whitespace gate; the table ends without one
		const fixture = readFileSync(join(import.meta.dirname, "fixtures", "tool-table-0.40.6.txt"), "utf8").replace(/\n$/, "");
		expect(Buffer.byteLength(fixture, "utf8")).toBe(1128); // bytes, not UTF-16 units: the em-dashes are three bytes each
		expect(composeToolTable(registry, CODING_TOOL_RULES)).toBe(fixture);
	});
});
