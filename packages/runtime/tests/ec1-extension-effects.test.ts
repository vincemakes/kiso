/**
 * EC-1 ② — an extension-registered tool's `effects` certificate must
 * survive the DISK loader.
 *
 * Why this test exists as its own file: the effects field is worthless if
 * only built-ins can carry it. A third-party tool that cannot declare
 * `concurrency: "shared"` is condemned to the conservative default forever,
 * and the kernel would be enforcing a contract that only kiso's own tools
 * can participate in. The loader validates shape (`Array.isArray(e.tools)`)
 * and the agent registers the tool OBJECT by reference — so nothing strips
 * unknown fields — but "so it looks" is not evidence, and the kill9 gate is
 * about to depend on this working.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadExtensions } from "../src/index.js";

/** A test-authored extension, written to disk exactly as a third party
 *  would ship one — a plain .mjs the loader discovers. */
const EXT_SOURCE = `export default {
	name: "slow-tools",
	tools: [
		{
			name: "slow_touch",
			description: "sleep, then write a marker",
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, ms: { type: "number" } },
				required: ["path"],
			},
			effects: { concurrency: "shared" },
			execute: async () => ({ content: "ok", isError: false }),
		},
	],
};
`;

describe("EC-1 ② — the effects certificate survives the extension load path", () => {
	it("a disk-loaded extension tool keeps its declaration verbatim", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-ec1-ext-"));
		writeFileSync(join(dir, "slow-tools.mjs"), EXT_SOURCE, "utf8");

		const loaded = await loadExtensions(dir);
		const ext = loaded.find((e) => e.name === "slow-tools");
		expect(ext).toBeDefined();
		const tool = (ext!.tools ?? []).find((t) => t.name === "slow_touch");
		expect(tool).toBeDefined();

		// The whole point: the certificate crossed the module boundary intact.
		// If this ever fails, the field is built-ins-only and that is a
		// product gap, not a test to relax.
		expect(tool!.effects).toEqual({ concurrency: "shared" });
		// And the conservative default is genuinely absent, not defaulted in:
		// undeclared precommitSafe stays undefined, so the call is still
		// commit-gated exactly like an undeclared tool.
		expect(tool!.effects?.precommitSafe).toBeUndefined();
	});
});
