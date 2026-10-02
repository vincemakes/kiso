/**
 * Windows P3 — a SKILL.md saved with CRLF line endings is indexed.
 *
 * The frontmatter reader looked for "---\n", so a skill saved on Windows
 * (or by any editor that writes CRLF) read as having no frontmatter and
 * dropped out of the index. Runs on every OS.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import createSkillsExtension from "../dist/kiso-skills.mjs";

async function indexOf(skillMd: string): Promise<string | undefined> {
	const dir = mkdtempSync(join(tmpdir(), "kiso-skills-crlf-"));
	mkdirSync(join(dir, "deploy"), { recursive: true });
	writeFileSync(join(dir, "deploy", "SKILL.md"), skillMd, "utf8");
	process.env.KISO_SKILLS_DIR = dir;
	try {
		return (await createSkillsExtension()).systemPrompt?.append;
	} finally {
		delete process.env.KISO_SKILLS_DIR;
	}
}

describe("SKILL.md line endings", () => {
	it("a CRLF frontmatter is read, its description indexed", async () => {
		expect(await indexOf("---\r\ndescription: ship the build\r\n---\r\nsteps\r\n")).toContain("- deploy: ship the build");
	});

	it("an LF frontmatter, as before (guard)", async () => {
		expect(await indexOf("---\ndescription: ship the build\n---\nsteps\n")).toContain("- deploy: ship the build");
	});
});
