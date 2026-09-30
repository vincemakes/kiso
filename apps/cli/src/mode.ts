/**
 * Modes — the six built-in approval tiers, built ON the E1 policy chain
 * (the kernel is untouched). Each tier is an in-process "mode:<name>"
 * extension whose decide() is live — it only speaks when it is the
 * CURRENT tier (otherwise abstain = no opinion, ADR-0042), so /mode
 * switches take effect immediately. The extension NAME rides the runtime's decidedBy
 * field: an automated denial records decidedBy: "mode:<name>" — the
 * audit sell. User-level extensions stay on the chain AFTER the mode
 * tiers; a user deny always wins (the chain's deny>allow>ask
 * monotonicity — bypass cannot override an extension deny).
 */

import type { PolicyCall, PolicyVerdict } from "@vincemakes/kiso-core";
import type { KisoExtension } from "@vincemakes/kiso-runtime";
import { isProtectedWrite } from "./protected-writes.js";

export type Mode = "manual" | "default" | "accept-edits" | "plan" | "bypass" | "dontAsk";

/** Every tier kiso ACCEPTS — from a config, KISO_MODE, --mode, or
 *  `/mode <name>`. */
export const MODES: readonly Mode[] = ["manual", "default", "accept-edits", "plan", "bypass", "dontAsk"];

/** The tiers kiso OFFERS a person (launch-weekend plan §2): the picker,
 *  shift+tab, the printed list, the help. `manual` left the offer — a
 *  saved allow outranks its ask, so "asks for every tool" was never
 *  quite what it did — and stays accepted, so no config that names it
 *  breaks. `dontAsk` joined: the unattended tier. */
export const OFFERED_MODES: readonly Mode[] = ["default", "accept-edits", "plan", "dontAsk", "bypass"];

/** DC-36 — one line per tier, for the picker, TRANSCRIBED FROM decide()
 *  below rather than written fresh. A description that drifts from the
 *  behaviour is worse than none: this is the row a human reads before
 *  handing over the approval gate.
 *
 *  Astra F4: these describe THE TIER'S CONTRIBUTION TO THE CHAIN, not the
 *  chain's verdict. "every tool asks" read as a promise that manual is a
 *  revocation — pick it and you are asked about everything again — and it
 *  is not. A tier that ASKS abstains in favour of anything that ALLOWS, so
 *  a saved don't-ask-again rule still allows, and the side effect runs with
 *  no new question. The composition (deny > allow > ask) is the ruling and
 *  is unchanged; the copy was the thing that was wrong. `plan` needs no
 *  qualification because it DENIES, and a deny is what nothing overrides. */
// 0.40.0: every OFFERED note fits the picker at 80 columns — 60 columns:
// 80, less the 19 of the label column, less the last column, which is
// never written — so the qualification at the END of a note is never the
// part that is cut (the PTY picker gate asserts them whole).
export const MODE_NOTE: Readonly<Record<Mode, string>> = {
	manual: "asks for every tool — a saved allow still allows",
	default: "read-only runs; the rest asks — a saved allow still allows",
	"accept-edits": "read-only, edits run; rest asks — a saved allow still allows",
	plan: "reads run; all else is denied — read-only, and a deny wins",
	bypass: "everything runs, nothing asks — a user deny still wins",
	dontAsk: "asks nothing: an ask is denied — a saved allow still allows",
};

/** The read-only tool set (plan): reading is allowed, everything else
 *  denied with the guiding reason. */
const READ_TOOLS = new Set(["read_file", "list_dir", "search_text", "read_skill"]);
/** ADR-0058 (3b, D2): stopping a task this session started asks no one —
 *  stopping is the safe direction — in every tier but manual. */
const STOP_TOOLS = new Set(["task_stop"]);

let current: Mode = "default";

export function getMode(): Mode {
	return current;
}

export function setMode(m: Mode): void {
	current = m;
}

/** The startup mode from env: KISO_MODE, or undefined when unset (the
 *  config layer's mode then applies — merge round B; the --mode flag is
 *  applied by main before the first createCodingAgent and wins over everything). */
export function modeFromEnv(): Mode | undefined {
	const raw = process.env.KISO_MODE;
	return MODES.find((x) => x === raw);
}

/** The per-tier verdict for a tool call — only when this tier is current. */
function tierVerdict(tier: Mode, call: PolicyCall, workspaceRoot: () => string): PolicyVerdict {
	if (tier !== current) return { action: "abstain" }; // not our tier — no opinion
	switch (tier) {
		case "manual":
			return { action: "ask" }; // every tool asks
		// dontAsk decides exactly as default does. What makes it dontAsk is
		// what happens to the chain's final ASK: the CLI denies it at the
		// ask endpoint instead of asking (chat.ts). Not a tier deny — that
		// would outrank every allow, and a saved allow and the read-only
		// shell allow must still allow.
		case "default":
		case "dontAsk":
			if (READ_TOOLS.has(call.name) || STOP_TOOLS.has(call.name)) return { action: "allow" };
			if (call.name === "write_file" || call.name === "edit_file" || call.name === "shell") return { action: "ask" };
			// Abstain (ADR-0042): an extension-provided tool is the
			// EXTENSIONS' business — the tier neither allows nor denies.
			// The chain falls to the ask flow when nobody else speaks, so
			// an uncovered external tool STILL meets the human (the P2
			// finding: "allow"-as-no-opinion auto-approved it).
			return { action: "abstain" };
		case "accept-edits":
			if (READ_TOOLS.has(call.name) || STOP_TOOLS.has(call.name)) return { action: "allow" };
			// 0.40.0: a write into .git/ or .kiso/ asks even here — both hold
			// configuration that runs (protected-writes.ts)
			if (call.name === "write_file" || call.name === "edit_file") return isProtectedWrite(call, workspaceRoot()) ? { action: "ask" } : { action: "allow" };
			if (call.name === "shell") return { action: "ask" };
			return { action: "abstain" }; // see "default"
		case "plan":
			if (READ_TOOLS.has(call.name) || STOP_TOOLS.has(call.name)) return { action: "allow" };
			return { action: "deny", reason: "plan mode: read-only" };
		case "bypass":
			return { action: "allow" }; // everything — a REAL allow, never an abstain
	}
}

/** The six built-in mode tiers as chain extensions — named "mode:<tier>"
 *  so the runtime's decidedBy records exactly that (the runtime derives
 *  approvalPolicies from extensions[].approvals, tagging each with the
 *  extension name). The CURRENT tier is first: an all-allow chain records
 *  decidedBy = the FIRST SPEAKER, so an auto-allow under the startup mode
 *  names that mode honestly. Order never affects verdicts — the chain is
 *  deny>allow>ask over the SPEAKING verdicts (abstain = no opinion), so a
 *  user extension's deny wins over any mode tier, bypass included (the
 *  monotonicity e2e pins it). */
export function modeExtensions(workspaceRoot: () => string = () => process.cwd()): readonly KisoExtension[] {
	return [...MODES.filter((m) => m === current), ...MODES.filter((m) => m !== current)].map((m) => ({
		name: `mode:${m}`,
		approvals: [
			{
				decide: async (payload) => tierVerdict(m, { name: payload.name, input: payload.input ?? {} }, workspaceRoot),
			},
		],
	}));
}

/** The plan tier's system prompt addition — injected at startup when the
 *  initial mode is plan (the session prompt is fixed at creation; runtime
 *  switches are guided by the deny reason). */
export function modeSystemPrompt(): string | undefined {
	if (current !== "plan") return undefined;
	return (
		"plan mode: read-only. You may inspect the workspace (read_file, list_dir, search_text, " +
		"read_skill) but every write/edit/shell call is DENIED with 'plan mode: read-only'. " +
		"Produce a concrete plan (files, searches, proposed edits) as your output; the human " +
		"switches to another mode to execute it."
	);
}
