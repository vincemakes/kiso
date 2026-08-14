/**
 * R-D 0.1.45 — the built-in layer: the three official extensions (mcp,
 * skills, subagent), shipped in the cli package and registered by
 * MODULE IMPORT — never a disk scan (the user layer's loadExtensions stays
 * word-for-word untouched). The cascade, base → top: built-in → user
 * (~/.kiso/extensions) → project (.kiso/extensions, trust-gated).
 *
 * E5 (the composition round, finding E5-F1/F2): the task extension left
 * the default composition — on 13 consecutive real-provider sessions it
 * paid its rent (system:ext:task + tool:task_set on every request) and
 * was never called, not even on the guidance's own designed trigger. It
 * stays an official extension, OPT-IN via the user layer: copy
 * extensions/task/src/kiso-task.mjs into ~/.kiso/extensions/ (a user or
 * project extension named "task" is now a plain extension — no built-in
 * to shadow or collide with).
 *
 *  - a user extension may SHADOW a built-in by name — the user's deliberate
 *    install wins (a built-in cannot be uninstalled), loudly, and the
 *    shadowed built-in leaves the loaded set and the banner;
 *  - the project layer may NOT shadow anything below — the same-name
 *    refusal the loader already applies to the user layer, spelled out
 *    for the built-in layer too.
 */
import createMcp from "@vincemakes/kiso-mcp-ext";
import createSkills from "@vincemakes/kiso-skills-ext";
import createSubagent from "@vincemakes/kiso-subagent-ext";
import type { KisoExtension } from "@vincemakes/kiso-runtime";

export async function builtInLayer(
	user: readonly KisoExtension[],
	project: readonly KisoExtension[],
): Promise<readonly KisoExtension[]> {
	const all = await Promise.all([createMcp(), createSkills(), createSubagent()]);
	const shadowed = all.filter((b) => user.some((u) => u.name === b.name));
	for (const s of shadowed) {
		console.error(`[extensions] user extension "${s.name}" shadows the built-in — the built-in is not loaded`);
	}
	for (const p of project) {
		if (all.some((b) => b.name === p.name)) {
			throw new Error(`[extensions] extension name "${p.name}" exists in both the built-in and the project-level extensions — refusing to shadow`);
		}
	}
	return all.filter((b) => !shadowed.includes(b));
}
