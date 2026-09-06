/**
 * DC-49 — THE HOME DIRECTORY AS A WORKSPACE.
 *
 * The owner runs kiso from `~`. That is ALLOWED (ruled 2026-09-06): no
 * refusal, no warning. What it costs is that discovery — the walks that
 * answer "what is in this tree" — reaches kiso's own state directory and
 * reports the user's session logs as though they were their work.
 *
 * `~/.kiso` escapes the tools-node walk today only BY ACCIDENT, because
 * the walk skips every `.`-name. A `KISO_HOME` pointed anywhere else is
 * walked in full — which is what these cases drive, deliberately, with a
 * NON-dot directory.
 *
 * DISCOVERY, NOT ACCESS. The exclusion removes a directory from what a
 * walk FINDS when it descends from above. It is not a permission: a path
 * the user or the model NAMES is still served, at the root or inside it.
 * The two are easy to conflate and conflating them would make this look
 * like a security boundary, which it is not — anything the model can
 * name, it can still read.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { listDirTool, readFileTool, searchTextTool } from "../src/index.js";
import type { ToolContext } from "@vincemakes/kiso-core";

const CTX: ToolContext = {
	signal: { aborted: false, addEventListener: () => {}, removeEventListener: () => {} },
} as unknown as ToolContext;

const NEEDLE = "quillfeather";
let ROOT = "";
let EXCLUDED = "";

beforeAll(() => {
	ROOT = mkdtempSync(join(tmpdir(), "kiso-dc49-"));
	// NOT a dot-directory: the dot rule would hide it and the gate would
	// pass without the feature existing.
	EXCLUDED = join(ROOT, "kisostate");
	mkdirSync(EXCLUDED, { recursive: true });
	mkdirSync(join(EXCLUDED, "sessions"), { recursive: true });
	writeFileSync(join(EXCLUDED, "sessions", "s1.jsonl"), `a session mentioning ${NEEDLE}\n`);
	writeFileSync(join(EXCLUDED, "config.json"), `{"note":"${NEEDLE}"}\n`);
	// ordinary work, which must still be found
	mkdirSync(join(ROOT, "project"), { recursive: true });
	writeFileSync(join(ROOT, "project", "main.ts"), `const x = "${NEEDLE}";\n`);
});

const opts = () => ({ workspaceRoot: ROOT, excludeRoots: [EXCLUDED] });

describe("DC-49 — a walk does not descend into an excluded root", () => {
	it("NON-VACUITY: without the exclusion the walk DOES find it", async () => {
		// Every assertion below is negative, and a negative assertion over a
		// directory the walk would have skipped anyway is green forever.
		const tool = searchTextTool({ workspaceRoot: ROOT });
		const res = await tool.execute({ pattern: NEEDLE }, CTX);
		expect(res.content).toContain("s1.jsonl");
	});

	it("search_text skips it, and the ordinary work is still found", async () => {
		const tool = searchTextTool(opts());
		const res = await tool.execute({ pattern: NEEDLE }, CTX);
		expect(res.content, "the excluded root was walked").not.toContain("s1.jsonl");
		expect(res.content, "the exclusion swallowed the real work too").toContain("main.ts");
	});

	it("the skip is COUNTED and said — a scoped result that looks total is a lie", async () => {
		const tool = searchTextTool(opts());
		const res = await tool.execute({ pattern: NEEDLE }, CTX);
		expect(res.content).toContain("1 directory excluded");
	});

	it("the note is ABSENT when nothing was excluded", async () => {
		const tool = searchTextTool({ workspaceRoot: ROOT, excludeRoots: [join(ROOT, "nowhere")] });
		const res = await tool.execute({ pattern: NEEDLE }, CTX);
		expect(res.content).not.toContain("excluded");
	});
});

describe("DC-49 — an EXPLICIT path is served, at the root and inside it", () => {
	// The reviewer's constraint (c): the exclusion applies only when a walk
	// would DESCEND into the root from above. Naming it is not descending.
	it("list_dir ON the excluded root lists it", async () => {
		const tool = listDirTool(opts());
		const res = await tool.execute({ path: "kisostate" }, CTX);
		expect(res.isError).toBe(false);
		expect(res.content).toContain("config.json");
	});

	it("list_dir INSIDE the excluded root lists it", async () => {
		const tool = listDirTool(opts());
		const res = await tool.execute({ path: "kisostate/sessions" }, CTX);
		expect(res.content).toContain("s1.jsonl");
	});

	it("read_file inside the excluded root reads it", async () => {
		const tool = readFileTool(opts());
		const res = await tool.execute({ path: "kisostate/config.json" }, CTX);
		expect(res.isError).toBe(false);
		expect(res.content).toContain(NEEDLE);
	});

	it("search_text AIMED AT the excluded root searches it", async () => {
		const tool = searchTextTool(opts());
		const res = await tool.execute({ pattern: NEEDLE, path: "kisostate" }, CTX);
		expect(res.content, "an explicitly named root was refused").toContain("s1.jsonl");
	});
});
