/**
 * kiso official skills extension — ⑤: two-tier progressive skills,
 * kernel untouched.
 *
 * Tier 1 (resident): the skills index — every ${KISO_SKILLS_DIR:-~/.kiso/
 * skills}/<name>/SKILL.md's frontmatter (a --- wrapped YAML SUBSET; only
 * name/description/user-invocable are read, by a hand-written parser — no
 * deps) becomes
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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_DESCRIPTION = 200;
const MAX_BODY = 32 * 1024;

/** finding #11: KISO_HOME is the ONE root — the default skills dir derives
 *  from it (KISO_SKILLS_DIR still overrides). */
function kisoHome() {
	return process.env.KISO_HOME ?? join(homedir(), ".kiso");
}

/**
 * `options` are for a host; the CLI passes none.
 * - `roots`: directories to scan, in order. Given, they replace the
 *   default (KISO_SKILLS_DIR, else $KISO_HOME/skills); the env var is not read.
 * - `include(entry)`: false drops the skill from the ONE active index that
 *   the prompt, `read_skill`, the catalog and the count are all built
 *   from, so no surface can offer a skill another one hides. `broken`
 *   (installation diagnostics) is not filtered.
 */
export default async function createSkillsExtension(options = {}) {
	const roots = options.roots ?? [process.env.KISO_SKILLS_DIR ?? join(kisoHome(), "skills")];
	const { index: loaded, broken } = firstNameWins(roots.map((root) => loadIndex(root)));
	const index = options.include === undefined ? loaded : loaded.filter((s) => options.include(entryOf(s)));
	// finding #8: no persistent resources — SKILL.md files are read per call;
	// nothing is spawned or connected — no dispose is needed, explicitly.
	const catalog = skillsCatalog(index, broken);
	if (index.length === 0 && broken.length === 0) return { name: "skills", skills: 0, tools: [], catalog };
	const tools = index.length > 0 ? [readSkillTool(index, broken)] : [];
	return {
		name: "skills",
		tools,
		// §2.5: how many skills THIS load indexed. The CLI's reload line reads
		// it here rather than walking the directory again — one scan, one
		// answer, and no second count free to disagree with this one.
		skills: index.length,
		// 0.40.0: the same scan, handed to the CLI for `/skill` and
		// `/skills` — the person's door and the model's index cannot list
		// different skills, because they are one list.
		catalog,
		systemPrompt: { append: skillsPromptAppend(index, broken) },
	};
}

/** Scan ${dir}/<name>/SKILL.md, parse the frontmatter subset, sort by
 *  directory name. Broken entries are SOFT failures — recorded, skipped.
 *  finding #9 (P2): a symlink to a directory IS a skill dir — the
 *  CC-compatible migration path (`ln -s ~/.claude/skills/x
 *  ~/.kiso/skills/x`) must work; a broken link (target missing or not a
 *  directory) is a soft failure like any other broken skill, never an
 *  error. */
function loadIndex(skillsDir) {
	let dirs;
	let brokenLinks = [];
	try {
		const entries = readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		dirs = [];
		for (const d of entries) {
			if (d.isDirectory()) {
				dirs.push(d.name);
			} else if (d.isSymbolicLink()) {
				try {
					if (statSync(join(skillsDir, d.name)).isDirectory()) dirs.push(d.name);
					else brokenLinks.push({ dir: d.name, reason: "symlink target is not a directory" });
				} catch {
					brokenLinks.push({ dir: d.name, reason: "broken symlink" });
				}
			}
		}
	} catch {
		return { index: [], broken: [] }; // no skills dir = no skills, never an error
	}
	const index = [];
	const broken = brokenLinks; // finding #9: broken links join the existing soft-failure path
	for (const dir of dirs) {
		const path = join(skillsDir, dir, "SKILL.md");
		let text;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			broken.push({ dir, reason: "no SKILL.md" });
			continue;
		}
		const parsed = parseFrontmatter(text);
		if (parsed === null) {
			broken.push({ dir, reason: "no frontmatter" });
			continue;
		}
		const { meta, emptyBlocks } = parsed;
		// RF-2: a `>`/`|` with nothing under it is a mistake in the file, not
		// an empty value — say so, rather than "no description"
		if (emptyBlocks.has("name") || emptyBlocks.has("description")) {
			broken.push({ dir, reason: "empty block scalar" });
			continue;
		}
		const name = (meta.name ?? dir).trim();
		// RF-2: a name is matched against `/skill <name>` and printed on one
		// index line — a `|` block or a quoted "\n" cannot make it two
		if (/[\r\n]/.test(name)) {
			broken.push({ dir, reason: "name is not one line" });
			continue;
		}
		// the index is ONE line per skill: only a value that CARRIES a newline
		// (a `|` block, a quoted "\n") is collapsed — a plain value's bytes are
		// exactly what they were before RF-2, inner spacing included
		const rawDescription = meta.description ?? "";
		let description = (/[\r\n]/.test(rawDescription) ? rawDescription.replace(/\s+/g, " ") : rawDescription).trim();
		if (description === "") {
			broken.push({ dir, reason: "no description" });
			continue;
		}
		if (description.length > MAX_DESCRIPTION) description = `${description.slice(0, MAX_DESCRIPTION)}…[truncated]`;
		// `user-invocable: false` (the key other harnesses use) keeps a skill
		// out of the person's reach and in the model's. Only the literal
		// `false` counts: absence cannot be told apart from a skill written
		// before the key existed, so absence is invocable.
		index.push({ name, description, dir, path, userInvocable: meta["user-invocable"] !== "false" });
	}
	return { index, broken };
}

/** A name found twice resolves to its FIRST occurrence — root order, then
 *  the directory sort within a root — and every later one is reported in
 *  `broken`, never listed. `read_skill` always served the first; the index
 *  used to list both, offering a skill nobody could load. Resolved before
 *  a host's `include`, so a filter cannot change which one wins. */
function firstNameWins(scans) {
	const index = [];
	const broken = [];
	const winners = new Map();
	scans.forEach((scan, root) => {
		broken.push(...scan.broken);
		for (const skill of scan.index) {
			const first = winners.get(skill.name);
			if (first === undefined) {
				winners.set(skill.name, { skill, root });
				index.push(skill);
				continue;
			}
			const where = first.root === root ? first.skill.dir : `${first.skill.dir} in an earlier root`;
			broken.push({ dir: skill.dir, reason: `duplicate name "${skill.name}" — already provided by ${where}` });
		}
	});
	return { index, broken };
}

/** The published entry shape — the catalog's, and what `include` is shown. */
function entryOf({ name, description, dir, path, userInvocable }) {
	return { name, description, dir, path, userInvocable };
}

/** 0.40.0 — what the CLI reads to let a PERSON invoke a skill. `body` reads
 *  the file at call time (finding #8: nothing is held), strips the
 *  frontmatter, and refuses — never truncates — a body over the cap: a
 *  skill cut in half is a different instruction than the one written. */
function skillsCatalog(index, broken) {
	return {
		entries: index.map(entryOf),
		broken: broken.map(({ dir, reason }) => ({ dir, reason })),
		body(name) {
			const skill = index.find((s) => s.name === name);
			if (skill === undefined) return { error: "not installed" };
			let text;
			try {
				text = readFileSync(skill.path, "utf8");
			} catch (err) {
				return { error: `cannot read ${skill.path}: ${err instanceof Error ? err.message : String(err)}` };
			}
			const end = text.indexOf("\n---", 4);
			const body = text.slice(end + 4).replace(/^[^\n]*\n?/, "").trim();
			if (body.length > MAX_BODY) return { error: `over the ${MAX_BODY.toLocaleString("en-US")}-character skill cap (${body.length.toLocaleString("en-US")} characters)` };
			return { body };
		},
	};
}

/** The --- wrapped YAML subset: top-level `key: value` lines; the loader
 *  reads `name`, `description` and `user-invocable` (everything else is
 *  ignored). Null = no valid frontmatter.
 *
 *  RF-2: skills written for other harnesses use real YAML, so a value may
 *  be a BLOCK scalar (`>` folds its lines with spaces, `|` keeps them; an
 *  optional chomping `+`/`-` is accepted) whose text is the following lines
 *  indented deeper than the key, or a double/single-QUOTED scalar. The flat
 *  reader indexed `description: >` as the literal ">" and dropped the text.
 *  A block indicator with no indented lines records the key in
 *  `emptyBlocks` — the caller names it a broken entry, never an empty
 *  description. Anchors, flow collections and nesting stay out of scope:
 *  the index needs three string keys. */
function parseFrontmatter(text) {
	if (!text.startsWith("---\n")) return null;
	const end = text.indexOf("\n---", 4);
	if (end < 0) return null;
	const lines = text.slice(4, end).split("\n");
	const meta = {};
	const emptyBlocks = new Set();
	for (let i = 0; i < lines.length; i += 1) {
		const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[i]);
		if (m === null) continue;
		const [, key, rawValue] = m;
		const value = rawValue.trim();
		if (/^[>|][+-]?$/.test(value)) {
			// the block: every following line indented deeper than the key
			// (a blank line inside the block belongs to it)
			const block = [];
			while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || (lines[i + 1].trim() === "" && block.length > 0))) block.push(lines[(i += 1)]);
			while (block.length > 0 && block[block.length - 1].trim() === "") block.pop();
			if (block.length === 0) {
				emptyBlocks.add(key);
				meta[key] = "";
				continue;
			}
			const indent = Math.min(...block.filter((l) => l.trim() !== "").map((l) => /^\s*/.exec(l)[0].length));
			const body = block.map((l) => l.slice(indent));
			meta[key] = value.startsWith(">") ? body.map((l) => l.trim()).join(" ").replace(/ {2,}/g, " ").trim() : body.join("\n").trim();
		} else {
			meta[key] = unquote(value);
		}
	}
	return { meta, emptyBlocks };
}

/** RF-2: a quoted scalar's text — `"…"` with its backslash escapes, `'…'`
 *  with `''` for a quote. Anything else is returned as written. */
function unquote(value) {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\(["\\nt])/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
	return value;
}

/** Tier 1: the resident index — one line per skill, sorted by directory
 *  name, a warning line for every broken entry at the tail. */
function skillsPromptAppend(index, broken) {
	const lines = index.map((s) => `- ${s.name}: ${s.description}`);
	const warning =
		broken.length > 0 ? `\n[skills] skipped ${broken.length} broken skill(s): ${broken.map((b) => `${b.dir} (${b.reason})`).join(", ")}` : "";
	return `Available skills (load with read_skill):\n${lines.join("\n")}${warning}`;
}

/** Tier 2: read_skill — the full SKILL.md (≤32KB), or an honest,
 *  actionable unknown-name error listing the installed skills. */
function readSkillTool(index, broken) {
	const brokenNote = broken.length > 0 ? ` (${broken.length} broken skill(s) skipped: ${broken.map((b) => b.dir).join(", ")})` : "";
	return {
		name: "read_skill",
		description: "load a skill's SKILL.md (the available-skills list is in the system prompt)",
		parameters: { type: "object", properties: { name: { type: "string", minLength: 1 } }, required: ["name"], additionalProperties: false },
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
