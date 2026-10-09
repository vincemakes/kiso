/**
 * R-D 0.1.45 — the built-in layer: the three official extensions (mcp,
 * skills, subagent), shipped in the cli package and registered by
 * MODULE IMPORT — never a disk scan (the user layer's loadExtensions stays
 * word-for-word untouched). The cascade, base → top: built-in → user
 * (~/.kiso/extensions) → project (.kiso/extensions, trust-gated).
 *
 * E5 (the composition round, finding E5-F1/F2): the task extension left
 * the default composition — on 13 consecutive real-provider sessions it
 * paid its rent (its guidance and its tool on every request) and
 * was never called, not even on the guidance's own designed trigger —
 * and 0.44.0 retired it outright (no host used it either). A user or
 * project extension named "task" is a plain extension — no built-in to
 * shadow or collide with.
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
import createAsk, { type AskUI } from "@vincemakes/kiso-ask-ext";
import type { KisoExtension } from "@vincemakes/kiso-runtime";
import { getDontAsk } from "./mode.js";
import { bindingFor, tasksFor } from "./state.js";

/**
 * 0.40.0 (the owner's dogfood): dontAsk never asks, so its tool table never
 * offers ask_user — a model once put four questions to a dontAsk session
 * that could only decline them. A LIVE gate, not a load-time one: the
 * registry reads an extension's tools on every request (registerLive) and
 * the run recomposes the tool table, snippet and guidelines included, so
 * turning the switch on takes ask_user away from the next run and turning
 * it off brings ask_user back — in every tier. With the switch on the
 * table is byte-identical to the pipe path's; each flip costs one
 * prompt-cache break. The decline path (trust-ui) stays for a turn already
 * in flight when the switch flips.
 */
export function offInDontAsk(ext: KisoExtension): KisoExtension {
	const tools = ext.tools ?? [];
	return {
		...ext,
		get tools() {
			return getDontAsk() ? [] : tools;
		},
	};
}

export async function builtInLayer(
	user: readonly KisoExtension[],
	project: readonly KisoExtension[],
	/** KC3.5: built-in #4 — the ask extension, loaded ONLY when a panel
	 *  bridge exists (an interactive TTY). No bridge, no fourth built-in:
	 *  a headless session never pays the rent for a question nobody could
	 *  answer, and its tool table cannot mention ask_user. */
	ask?: AskUI,
	/** Astra F7: the env-var NAMES the configured profiles authenticate with.
	 *  The mcp extension spawns its stdio children while it is being
	 *  constructed, so the names have to arrive here — after construction is
	 *  too late. Only the config knows them; nothing else can. */
	secretEnvNames: readonly string[] = [],
): Promise<readonly KisoExtension[]> {
	// ADR-0058 3d: the session's task manager makes `delegate` offer
	// background children (explorer/reviewer; the cap and the turn budget
	// are the extension's defaults). 0.49.0 C1: the session's live binding
	// is the model a child runs on when its task names none.
	const all = await Promise.all([createMcp({ secretEnvNames }), createSkills(), createSubagent({ tasks: tasksFor, currentBinding: bindingFor }), ...(ask === undefined ? [] : [createAsk(ask).then(offInDontAsk)])]);
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
