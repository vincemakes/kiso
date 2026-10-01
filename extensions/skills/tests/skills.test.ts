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

	it("⑪ KISO_HOME is the ONE root — the skills dir defaults under it (finding #11)", async () => {
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

	it("⑪ no KISO_HOME, no override — the default derives from HOME (finding #11)", async () => {
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

describe("⑤ safe-defaults (the round's only change outside extensions/)", () => {
	it("read_skill joins the allow list — local user-installed docs, read_file trust", async () => {
		const mod = (await import(pathToFileURL(join(new URL("../../../examples", import.meta.url).pathname, "extensions", "safe-defaults.mjs")).href)) as {
			default: KisoExtension;
		};
		const decide = mod.default.approvals![0]!.decide;
		expect(decide({ name: "read_skill", input: {} }, ctx)).toMatchObject({ action: "allow" });
		expect(decide({ name: "mcp__status", input: {} }, ctx)).toMatchObject({ action: "allow" }); // finding #10 round: zero-arg read-only
		expect(decide({ name: "write_file", input: {} }, ctx)).toMatchObject({ action: "ask" });
	});
});

/** 0.40.0 — the catalog: the SAME scan the model's index came from, handed
 *  to the CLI so `/skill` and `/skills` never walk the directory a second
 *  time and get a second answer. */
type Catalog = {
	readonly entries: readonly { name: string; description: string; dir: string; path: string; userInvocable: boolean }[];
	readonly broken: readonly { dir: string; reason: string }[];
	body(name: string): { body: string } | { error: string };
};
const catalogOf = (ext: KisoExtension): Catalog => {
	const c = (ext as KisoExtension & { catalog?: Catalog }).catalog;
	if (c === undefined) throw new Error("no catalog on the extension");
	return c;
};

describe("0.40.0 skills: the catalog the CLI invokes from", () => {
	it("lists every indexed skill with its directory, and `user-invocable: false` marks a model-only skill", async () => {
		const dir = skillDir();
		writeSkill(dir, "review", "\nReview the diff.\n", { name: "review", description: "review code" });
		writeSkill(dir, "internal", "\nModel only.\n", { name: "internal", description: "for the model", "user-invocable": "false" });
		// anything but the literal `false` is invocable — absence cannot be
		// told apart from a skill written before the key existed
		writeSkill(dir, "odd", "\nOdd.\n", { name: "odd", description: "odd value", "user-invocable": "no" });
		const cat = catalogOf(await extWith(dir));
		expect(cat.entries.map((e) => [e.name, e.dir, e.userInvocable])).toEqual([
			["internal", "internal", false],
			["odd", "odd", true],
			["review", "review", true],
		]);
		// the model still sees and can load a model-only skill
		const ext = await extWith(dir);
		expect(ext.systemPrompt?.append).toContain("- internal: for the model");
	});

	it("broken entries carry the loader's own reason — the same words the model's warning line uses", async () => {
		const dir = skillDir();
		writeSkill(dir, "good", "\nbody\n", { description: "fine" });
		writeSkill(dir, "bad", "\nbody\n", { name: "bad" });
		mkdirSync(join(dir, "empty"));
		const ext = await extWith(dir);
		const cat = catalogOf(ext);
		expect(cat.broken).toEqual([
			{ dir: "bad", reason: "no description" },
			{ dir: "empty", reason: "no SKILL.md" },
		]);
		for (const b of cat.broken) expect(ext.systemPrompt?.append).toContain(`${b.dir} (${b.reason})`);
	});

	it("body() returns the SKILL.md body with the frontmatter stripped, read at call time", async () => {
		const dir = skillDir();
		writeSkill(dir, "review", "\nReview the diff.\nThen say so.\n", { name: "review", description: "review code" });
		const cat = catalogOf(await extWith(dir));
		expect(cat.body("review")).toEqual({ body: "Review the diff.\nThen say so." });
		// read per call (finding #8): an edit after load is what is sent
		writeSkill(dir, "review", "\nEdited.\n", { name: "review", description: "review code" });
		expect(cat.body("review")).toEqual({ body: "Edited." });
	});

	it("body() refuses a body over the read_skill cap rather than truncating it", async () => {
		const dir = skillDir();
		writeSkill(dir, "huge", `\n${"x".repeat(32 * 1024 + 1)}\n`, { name: "huge", description: "too big" });
		const r = catalogOf(await extWith(dir)).body("huge");
		expect("error" in r ? r.error : "").toMatch(/^over the 32,768-character skill cap \(\d[\d,]* characters\)$/);
	});

	it("an empty skills directory still carries an empty catalog", async () => {
		const cat = catalogOf(await extWith(skillDir()));
		expect(cat.entries).toEqual([]);
		expect(cat.broken).toEqual([]);
	});
});

/** RF-2 (a host's report, 2026-09-18) — the frontmatter reader was a flat
 *  `key: value` line reader, so `description: >` indexed as the literal
 *  ">" and the folded text was dropped silently. Skills written for other
 *  harnesses use real YAML block and quoted scalars; the README promises
 *  they drop in and work. */
function writeRaw(dir: string, name: string, frontmatter: string, body = "\nbody\n"): void {
	mkdirSync(join(dir, name), { recursive: true });
	writeFileSync(join(dir, name, "SKILL.md"), `---\n${frontmatter}---\n${body}`, "utf8");
}

describe("RF-2 skills: block and quoted scalars in the frontmatter", () => {
	it("`>` folds its indented lines into one description", async () => {
		const dir = skillDir();
		writeRaw(dir, "fold", "name: fold\ndescription: >\n  Review the diff for\n  correctness and style.\nother: x\n");
		const ext = await extWith(dir);
		expect(ext.systemPrompt?.append).toContain("- fold: Review the diff for correctness and style.");
	});

	it("`|` keeps its lines, and the index collapses them to one line", async () => {
		const dir = skillDir();
		writeRaw(dir, "lit", "name: lit\ndescription: |\n  First line.\n  Second line.\n");
		const ext = await extWith(dir);
		expect(ext.systemPrompt?.append).toContain("- lit: First line. Second line.");
	});

	it("chomping indicators (`>-`, `|+`) and deeper indentation are accepted", async () => {
		const dir = skillDir();
		writeRaw(dir, "chomp", "name: chomp\ndescription: >-\n    Deeply indented\n    folded text.\n");
		const ext = await extWith(dir);
		expect(ext.systemPrompt?.append).toContain("- chomp: Deeply indented folded text.");
	});

	it("double- and single-quoted scalars are unquoted", async () => {
		const dir = skillDir();
		writeRaw(dir, "dq", 'name: "dq"\ndescription: "Say \\"hi\\": politely"\n');
		writeRaw(dir, "sq", "name: 'sq'\ndescription: 'It''s quoted'\n");
		const ext = await extWith(dir);
		expect(ext.systemPrompt?.append).toContain('- dq: Say "hi": politely');
		expect(ext.systemPrompt?.append).toContain("- sq: It's quoted");
	});

	it("a block indicator with no continuation is a broken entry, named", async () => {
		const dir = skillDir();
		writeRaw(dir, "good", "description: fine\n");
		writeRaw(dir, "empty", "name: empty\ndescription: >\nother: x\n");
		const ext = await extWith(dir);
		expect(ext.systemPrompt?.append).not.toContain("- empty:");
		expect(ext.systemPrompt?.append).toContain("empty (empty block scalar)");
	});

	it("the plain `key: value` form is unchanged — inner spacing included, byte for byte", async () => {
		const dir = skillDir();
		writeRaw(dir, "plain", "name: plain\ndescription: a plain line: with a colon\n");
		writeRaw(dir, "spaced", "name: spaced\ndescription: two  spaces\tand a tab\n");
		const ext = await extWith(dir);
		expect(ext.systemPrompt?.append).toContain("- plain: a plain line: with a colon");
		expect(ext.systemPrompt?.append).toContain("- spaced: two  spaces\tand a tab");
	});

	it("a quoted value whose escape makes a newline is collapsed to one index line", async () => {
		const dir = skillDir();
		writeRaw(dir, "esc", 'name: esc\ndescription: "first\\nsecond"\n');
		const ext = await extWith(dir);
		expect(ext.systemPrompt?.append).toContain("- esc: first second");
	});

	it("a name that is not one line is a broken entry, named", async () => {
		const dir = skillDir();
		writeRaw(dir, "good", "description: fine\n");
		writeRaw(dir, "twoline", "name: |\n  two\n  lines\ndescription: fine\n");
		const ext = await extWith(dir);
		expect(ext.systemPrompt?.append).toContain("twoline (name is not one line)");
		expect(ext.systemPrompt?.append).not.toContain("- two");
	});
});

describe("a host names the roots and one filter governs every surface", () => {
	/** Build the extension from host options, with KISO_SKILLS_DIR pointed
	 *  somewhere else: a host's roots replace the default scan, env included. */
	async function extFrom(options: Record<string, unknown>, decoy?: string): Promise<KisoExtension> {
		if (decoy !== undefined) process.env.KISO_SKILLS_DIR = decoy;
		try {
			return await createSkillsExtension(options);
		} finally {
			delete process.env.KISO_SKILLS_DIR;
		}
	}
	type Catalog = {
		entries: { name: string; description: string; dir: string; path: string; userInvocable: boolean }[];
		broken: { dir: string; reason: string }[];
		body(name: string): { body: string } | { error: string };
	};
	const catalogOf = (ext: KisoExtension): Catalog => (ext as unknown as { catalog: Catalog }).catalog;

	it("roots are scanned in the order given, and KISO_SKILLS_DIR is not read", async () => {
		const first = skillDir();
		const second = skillDir();
		const decoy = skillDir();
		writeSkill(first, "z-dir", "\n# Z\n", { name: "zeta", description: "from the first root" });
		writeSkill(second, "a-dir", "\n# A\n", { name: "alpha", description: "from the second root" });
		writeSkill(decoy, "d-dir", "\n# D\n", { name: "decoy", description: "must not appear" });
		const ext = await extFrom({ roots: [first, second] }, decoy);
		expect(ext.systemPrompt?.append).toBe(
			"Available skills (load with read_skill):\n- zeta: from the first root\n- alpha: from the second root",
		);
		expect((ext as unknown as { skills: number }).skills).toBe(2);
	});

	it("an excluded skill is absent from the index, read_skill, the catalog and the count", async () => {
		const root = skillDir();
		writeSkill(root, "keep", "\n# Keep\nkept body\n", { description: "kept" });
		writeSkill(root, "drop", "\n# Drop\ndropped body\n", { description: "dropped" });
		const ext = await extFrom({ roots: [root], include: (e: { name: string }) => e.name !== "drop" });
		expect(ext.systemPrompt?.append).toBe("Available skills (load with read_skill):\n- keep: kept");
		const refused = (await readSkill(ext).execute({ name: "drop" }, ctx)) as { content: string; isError: boolean };
		expect(refused.isError).toBe(true);
		expect(refused.content).toBe('[skills] unknown skill "drop" — available: keep');
		const allowed = (await readSkill(ext).execute({ name: "keep" }, ctx)) as { content: string; isError: boolean };
		expect(allowed.isError).toBe(false);
		expect(allowed.content).toContain("kept body");
		const catalog = catalogOf(ext);
		expect(catalog.entries.map((e) => e.name)).toEqual(["keep"]);
		expect(catalog.body("drop")).toEqual({ error: "not installed" });
		expect(catalog.broken).toEqual([]);
		expect((ext as unknown as { skills: number }).skills).toBe(1);
	});

	it("include receives the catalog entry shape", async () => {
		const root = skillDir();
		writeSkill(root, "one", "\n# One\n", { name: "one", description: "d", "user-invocable": "false" });
		const seen: unknown[] = [];
		await extFrom({ roots: [root], include: (e: unknown) => (seen.push(e), true) });
		expect(seen).toEqual([{ name: "one", description: "d", dir: "one", path: join(root, "one", "SKILL.md"), userInvocable: false }]);
	});

	it("a root that does not exist contributes nothing and is never an error", async () => {
		const root = skillDir();
		writeSkill(root, "only", "\n# Only\n", { description: "here" });
		const ext = await extFrom({ roots: [join(root, "missing"), root] });
		expect(ext.systemPrompt?.append).toBe("Available skills (load with read_skill):\n- only: here");
	});

	it("a name found twice in one root: the first directory wins, the second is reported, never listed", async () => {
		const root = skillDir();
		writeSkill(root, "01-deploy", "\n# First\nfirst body\n", { name: "deploy", description: "the first" });
		writeSkill(root, "02-deploy", "\n# Second\nsecond body\n", { name: "deploy", description: "the second" });
		const ext = await extWith(root);
		expect(ext.systemPrompt?.append).toBe(
			'Available skills (load with read_skill):\n- deploy: the first\n[skills] skipped 1 broken skill(s): 02-deploy (duplicate name "deploy" — already provided by 01-deploy)',
		);
		expect(catalogOf(ext).entries.map((e) => e.dir)).toEqual(["01-deploy"]);
		expect((ext as unknown as { skills: number }).skills).toBe(1);
	});

	it("a name found in two roots: the earlier root wins", async () => {
		const first = skillDir();
		const second = skillDir();
		writeSkill(first, "deploy", "\n# First\n", { description: "the first root's" });
		writeSkill(second, "deploy", "\n# Second\n", { description: "the second root's" });
		const ext = await extFrom({ roots: [first, second] });
		expect(ext.systemPrompt?.append).toBe(
			'Available skills (load with read_skill):\n- deploy: the first root\'s\n[skills] skipped 1 broken skill(s): deploy (duplicate name "deploy" — already provided by deploy in an earlier root)',
		);
	});

	it("duplicates resolve before include: excluding the winner does not promote the loser", async () => {
		const root = skillDir();
		writeSkill(root, "01-deploy", "\n# First\n", { name: "deploy", description: "the first" });
		writeSkill(root, "02-deploy", "\n# Second\n", { name: "deploy", description: "the second" });
		const ext = await extFrom({ roots: [root], include: (e: { dir: string }) => e.dir !== "01-deploy" });
		expect(catalogOf(ext).entries).toEqual([]);
		expect(catalogOf(ext).broken.map((b) => b.dir)).toEqual(["02-deploy"]);
		expect(ext.tools ?? []).toEqual([]);
	});
});
