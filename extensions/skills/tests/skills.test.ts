/**
 * ⑤ — the skills extension unit tests (against the BUILT dist/
 * kiso-skills.mjs): the tier-1 index in the system prompt (sorted), the
 * tier-2 read_skill roundtrip, honest unknown-name errors, soft-failed
 * broken skills with a warning line, overlong-description truncation, and
 * the empty/missing-dir no-error case. Plus the safe-defaults update:
 * read_skill is allowed (local docs, read_file trust).
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import createSkillsExtension from "../dist/kiso-skills.mjs";
import type { KisoExtension, Tool } from "@vincemakes/kiso-core";

const ctx = { signal: new AbortController().signal };

function skillDir(): string {
	return mkdtempSync(join(tmpdir(), "kiso-skills-"));
}

function writeSkill(dir: string, name: string, body: string, meta: Record<string, string> = {}): void {
	const d = join(dir, name);
	mkdirSync(d, { recursive: true });
	const fm = [`---`, ...Object.entries(meta).map(([k, v]) => `${k}: ${v}`), `---`, ``].join("\n");
	writeFileSync(join(d, "SKILL.md"), `${fm}${body}`, "utf8");
}

async function extWith(dir: string): Promise<KisoExtension> {
	process.env.KISO_SKILLS_DIR = dir;
	try {
		return await createSkillsExtension();
	} finally {
		delete process.env.KISO_SKILLS_DIR;
	}
}

const readSkill = (ext: KisoExtension): Tool => {
	const t = ext.tools?.find((x) => x.name === "read_skill");
	if (t === undefined) throw new Error("no read_skill tool");
	return t;
};

describe("⑤ skills: tier 1 — the resident index", () => {
	it("① the index lands in systemPrompt.append, sorted by directory name", async () => {
		const dir = skillDir();
		writeSkill(dir, "b-skill", "\n# B\nbody b\n", { name: "b-skill", description: "desc b" });
		writeSkill(dir, "a-skill", "\n# A\nbody a\n", { name: "a-skill", description: "desc a" });
		const ext = await extWith(dir);
		expect(ext.systemPrompt?.append).toBe(
			"Available skills (load with read_skill):\n- a-skill: desc a\n- b-skill: desc b",
		);
	});

	it("④ a broken SKILL.md (no frontmatter) is a SOFT failure — skipped, one warning line at the index tail", async () => {
		const dir = skillDir();
		writeSkill(dir, "good", "\n# Good\nbody\n", { description: "fine" });
		writeSkill(dir, "bad", "no frontmatter here\n");
		const ext = await extWith(dir);
		expect(ext.systemPrompt?.append).toContain("- good: fine");
		expect(ext.systemPrompt?.append).toContain("skipped 1 broken skill");
		expect(ext.systemPrompt?.append).toContain("bad");
		// The good skill still loads.
		const r = await readSkill(ext).execute({ name: "good" }, ctx);
		expect(r.isError).toBe(false);
	});

	it("⑤ an overlong description is truncated with a note", async () => {
		const dir = skillDir();
		const long = "d".repeat(300);
		writeSkill(dir, "a-skill", "\nbody\n", { description: long });
		const ext = await extWith(dir);
		expect(ext.systemPrompt?.append).toContain(`- a-skill: ${"d".repeat(200)}…[truncated]`);
	});

	it("⑧ a symlinked skill dir is discovered and indexed — the CC-compatible migration path (`ln -s ~/.claude/skills/x ~/.kiso/skills/x`)", async () => {
		const dir = skillDir();
		const real = skillDir();
		writeSkill(real, "linked-skill", "\n# Linked\nbody\n", { name: "linked-skill", description: "desc linked" });
		symlinkSync(join(real, "linked-skill"), join(dir, "linked-skill"));
		const ext = await extWith(dir);
		expect(ext.systemPrompt?.append).toContain("- linked-skill: desc linked");
		const r = await readSkill(ext).execute({ name: "linked-skill" }, ctx);
		expect(r.isError).toBe(false);
		expect(String(r.content)).toContain("# Linked");
	});

	it("⑨ a broken symlink is a SOFT failure — one warning line, never an error", async () => {
		const dir = skillDir();
		writeSkill(dir, "good", "\n# Good\nbody\n", { description: "fine" });
		symlinkSync(join(dir, "no-such-target"), join(dir, "dangling")); // → nowhere
		symlinkSync(join(dir, "good", "SKILL.md"), join(dir, "file-link")); // → a file, not a dir
		const ext = await extWith(dir);
		expect(ext.systemPrompt?.append).toContain("- good: fine");
		expect(ext.systemPrompt?.append).toContain("skipped 2 broken skill");
		expect(ext.systemPrompt?.append).toContain("dangling");
		expect(ext.systemPrompt?.append).toContain("file-link");
	});

	it("⑪ KISO_HOME is the ONE root — the skills dir defaults under it (发现#11)", async () => {
		const dir = skillDir();
		const home = join(dir, "home");
		mkdirSync(join(home, "skills", "home-skill"), { recursive: true });
		writeFileSync(join(home, "skills", "home-skill", "SKILL.md"), "---\ndescription: from home\n---\nbody\n", "utf8");
		process.env.KISO_HOME = home;
		delete process.env.KISO_SKILLS_DIR;
		try {
			const ext = await createSkillsExtension();
			expect(ext.systemPrompt?.append).toContain("- home-skill: from home");
		} finally {
			delete process.env.KISO_HOME;
		}
	});

	it("⑪ no KISO_HOME, no override — the default derives from HOME (发现#11)", async () => {
		const dir = skillDir();
		const fakeHome = join(dir, "fake-home");
		mkdirSync(join(fakeHome, ".kiso", "skills", "home-skill"), { recursive: true });
		writeFileSync(join(fakeHome, ".kiso", "skills", "home-skill", "SKILL.md"), "---\ndescription: from home\n---\nbody\n", "utf8");
		const origHome = process.env.HOME;
		process.env.HOME = fakeHome;
		delete process.env.KISO_HOME;
		delete process.env.KISO_SKILLS_DIR;
		try {
			const ext = await createSkillsExtension();
			expect(ext.systemPrompt?.append).toContain("- home-skill: from home");
		} finally {
			delete process.env.KISO_HOME;
			if (origHome === undefined) delete process.env.HOME;
			else process.env.HOME = origHome;
		}
	});

	it("⑥ a missing or empty skills dir is zero skills, never an error", async () => {
		const missing = await extWith(join(tmpdir(), "kiso-no-skills-dir-xyz"));
		expect(missing.name).toBe("skills");
		expect(missing.tools).toEqual([]);
		expect(missing.systemPrompt).toBeUndefined();
		const empty = await extWith(skillDir());
		expect(empty.tools).toEqual([]);
		expect(empty.systemPrompt).toBeUndefined();
	});
});

describe("⑤ skills: tier 2 — read_skill", () => {
	it("② read_skill returns the FULL SKILL.md", async () => {
		const dir = skillDir();
		writeSkill(dir, "a-skill", "\n# A skill\n\nDetailed body with a plan.\n", { description: "desc" });
		const ext = await extWith(dir);
		const r = await readSkill(ext).execute({ name: "a-skill" }, ctx);
		expect(r.isError).toBe(false);
		expect(String(r.content)).toContain("# A skill");
		expect(String(r.content)).toContain("Detailed body with a plan.");
	});

	it("③ an unknown name is an honest, actionable error — it lists the installed skills", async () => {
		const dir = skillDir();
		writeSkill(dir, "a-skill", "\nbody\n", { description: "desc a" });
		writeSkill(dir, "b-skill", "\nbody\n", { description: "desc b" });
		const ext = await extWith(dir);
		const r = await readSkill(ext).execute({ name: "nope" }, ctx);
		expect(r.isError).toBe(true);
		expect(String(r.content)).toContain('unknown skill "nope"');
		expect(String(r.content)).toContain("a-skill, b-skill");
	});
});

describe("⑤ safe-defaults (本轮唯一 extensions/ 外改动)", () => {
	it("read_skill joins the allow list — local user-installed docs, read_file trust", async () => {
		const mod = (await import(pathToFileURL(join(new URL("../../../examples", import.meta.url).pathname, "extensions", "safe-defaults.mjs")).href)) as {
			default: KisoExtension;
		};
		const decide = mod.default.approvals![0]!.decide;
		expect(decide({ name: "read_skill", input: {} }, ctx)).toMatchObject({ action: "allow" });
		expect(decide({ name: "mcp__status", input: {} }, ctx)).toMatchObject({ action: "allow" }); // 发现#10 round: zero-arg read-only
		expect(decide({ name: "write_file", input: {} }, ctx)).toMatchObject({ action: "ask" });
	});
});
