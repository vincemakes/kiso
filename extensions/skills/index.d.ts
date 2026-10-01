/**
 * The published type surface of @vincemakes/kiso-skills-ext: the default
 * export is the FACTORY (the same contract the user-layer disk loader
 * accepts — a KisoExtension or a factory returning one). The type import
 * from kiso-core is compile-time only — the shipped bundle is
 * self-contained, zero runtime dependencies.
 */
import type { KisoExtension } from "@vincemakes/kiso-core";

/** §2.5: the extension reports how many skills THAT load indexed, so a
 *  caller wanting the number does not walk the directory a second time and
 *  get a second answer free to disagree with this one. Absent means the
 *  load reported none — never a reason to guess. */
type SkillsExtension = KisoExtension & { readonly skills?: number; readonly catalog?: SkillsCatalog };

/** 0.40.0: the same scan, for the CLI's `/skill` and `/skills`. `body` reads
 *  the file at call time and returns the SKILL.md body without its
 *  frontmatter, or the reason it cannot (over the cap, unreadable). */
export interface SkillsCatalogEntry {
	readonly name: string;
	readonly description: string;
	/** the directory under the skills root the skill was found in */
	readonly dir: string;
	readonly path: string;
	/** false only for `user-invocable: false` — the model may still load it */
	readonly userInvocable: boolean;
}

export interface SkillsCatalog {
	readonly entries: readonly SkillsCatalogEntry[];
	/** the loader's own reason per skipped entry — the words the model's warning line uses */
	readonly broken: readonly { readonly dir: string; readonly reason: string }[];
	body(name: string): { readonly body: string } | { readonly error: string };
}

/** For a host; the CLI passes none, and omitting both keeps the default scan. */
export interface SkillsExtensionOptions {
	/** Directories to scan, in order. Given → replaces the default
	 *  (KISO_SKILLS_DIR, else $KISO_HOME/skills); the env var is not read.
	 *  A name found twice resolves to the first occurrence (root order,
	 *  then directory order); later ones are reported in `broken`. */
	readonly roots?: readonly string[];
	/** false → the skill is absent from the model's index, from `read_skill`,
	 *  from the catalog and from the count, which are all built from one
	 *  filtered list. Runs after duplicates resolve; `broken` is not filtered. */
	readonly include?: (entry: SkillsCatalogEntry) => boolean;
}

declare const createSkillsExtension: (options?: SkillsExtensionOptions) => SkillsExtension | Promise<SkillsExtension>;
export default createSkillsExtension;
