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
type SkillsExtension = KisoExtension & { readonly skills?: number };

declare const createSkillsExtension: () => SkillsExtension | Promise<SkillsExtension>;
export default createSkillsExtension;
