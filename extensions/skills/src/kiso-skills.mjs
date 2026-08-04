/**
 * kiso(基礎) official skills extension — ⑤: two-tier progressive skills,
 * kernel untouched.
 *
 * Tier 1 (resident): the skills index — every ${KISO_SKILLS_DIR:-~/.kiso/
 * skills}/<name>/SKILL.md's frontmatter (a --- wrapped YAML SUBSET; only
 * name/description are read, by a hand-written parser — no deps) becomes
 * one line of the system prompt, sorted by directory name:
 *   Available skills (load with read_skill):
 *   - <name>: <description>
 * A SKILL.md without frontmatter is skipped with a warning line at the
 * tail of that index (soft failure — the mcp philosophy). No/empty skills
 * dir → an empty extension, never an error.
 *
 * Tier 2 (on demand): the read_skill tool returns the FULL SKILL.md (capped
 * at 32KB with a truncation note); an unknown name is an honest,
 * actionable error listing the installed skills. Files other than
 * SKILL.md are NOT auto-loaded — the body tells the model to read them
 * with read_file by relative path (the progressive third tier; zero new
 * mechanisms).
 *
 * Compatible with Claude Code skills: the frontmatter name/description
 * subset parses CC skill files — drop one in and it works.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_DESCRIPTION = 200;
const MAX_BODY = 32 * 1024;

export default async function createSkillsExtension() {
	const skillsDir = process.env.KISO_SKILLS_DIR ?? join(homedir(), ".kiso", "skills");
	const { index, broken } = loadIndex(skillsDir);
	// 发现#8: no persistent resources — SKILL.md files are read per call;
	// nothing is spawned or connected — no dispose is needed, explicitly.
	if (index.length === 0 && broken.length === 0) return { name: "skills", tools: [] };
	const tools = index.length > 0 ? [readSkillTool(index, broken)] : [];
	return {
		name: "skills",
		tools,
		systemPrompt: { append: skillsPromptAppend(index, broken) },
	};
}

/** Scan ${dir}/<name>/SKILL.md, parse the frontmatter subset, sort by
 *  directory name. Broken entries are SOFT failures — recorded, skipped. */
function loadIndex(skillsDir) {
	let dirs;
	try {
		dirs = readdirSync(skillsDir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name)
			.sort();
	} catch {
		return { index: [], broken: [] }; // no skills dir = no skills, never an error
	}
	const index = [];
	const broken = [];
	for (const dir of dirs) {
		const path = join(skillsDir, dir, "SKILL.md");
		let text;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			broken.push(`${dir} (no SKILL.md)`);
			continue;
		}
		const meta = parseFrontmatter(text);
		if (meta === null) {
			broken.push(`${dir} (no frontmatter)`);
			continue;
		}
		const name = (meta.name ?? dir).trim();
		let description = (meta.description ?? "").trim();
		if (description === "") {
			broken.push(`${dir} (no description)`);
			continue;
		}
		if (description.length > MAX_DESCRIPTION) description = `${description.slice(0, MAX_DESCRIPTION)}…[truncated]`;
		index.push({ name, description, path });
	}
	return { index, broken };
}

/** The --- wrapped YAML subset: only `name:` and `description:` lines are
 *  read (everything else is ignored). Null = no valid frontmatter. */
function parseFrontmatter(text) {
	if (!text.startsWith("---\n")) return null;
	const end = text.indexOf("\n---", 4);
	if (end < 0) return null;
	const meta = {};
	for (const line of text.slice(4, end).split("\n")) {
		const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
		if (m !== null) meta[m[1]] = m[2].trim();
	}
	return meta;
}

/** Tier 1: the resident index — one line per skill, sorted by directory
 *  name, a warning line for every broken entry at the tail. */
function skillsPromptAppend(index, broken) {
	const lines = index.map((s) => `- ${s.name}: ${s.description}`);
	const warning =
		broken.length > 0 ? `\n[skills] skipped ${broken.length} broken skill(s): ${broken.join(", ")}` : "";
	return `Available skills (load with read_skill):\n${lines.join("\n")}${warning}`;
}

/** Tier 2: read_skill — the full SKILL.md (≤32KB), or an honest,
 *  actionable unknown-name error listing the installed skills. */
function readSkillTool(index, broken) {
	const brokenNote = broken.length > 0 ? ` (${broken.length} broken skill(s) skipped: ${broken.map((b) => b.split(" ")[0]).join(", ")})` : "";
	return {
		name: "read_skill",
		description: "load a skill's SKILL.md (the available-skills list is in the system prompt)",
		parameters: { type: "object", properties: { name: { type: "string", minLength: 1 } }, required: ["name"] },
		execute: async (input) => {
			const name = String((input ?? {}).name ?? "");
			const skill = index.find((s) => s.name === name);
			if (skill === undefined) {
				const names = index.length > 0 ? index.map((s) => s.name).join(", ") : "(none installed)";
				return {
					content: `[skills] unknown skill "${name}" — available: ${names}${brokenNote}`,
					isError: true,
					errorKind: "invalid_input",
				};
			}
			let text;
			try {
				text = readFileSync(skill.path, "utf8");
			} catch (err) {
				return { content: `[skills] cannot read ${skill.path}: ${err instanceof Error ? err.message : String(err)}`, isError: true, errorKind: "fatal" };
			}
			if (text.length > MAX_BODY) {
				text = `${text.slice(0, MAX_BODY)}\n…[truncated at ${MAX_BODY} chars — read the rest with read_file]`;
			}
			return { content: text, isError: false };
		},
	};
}
