/**
 * Modes — the five built-in approval tiers, built ON the E1 policy chain
 * (the kernel is untouched). Each tier is an in-process "mode:<name>"
 * extension whose decide() is live — it only speaks when it is the
 * CURRENT tier (otherwise abstain = no opinion, ADR-0042), so /mode
 * switches take effect immediately. The extension NAME rides the runtime's decidedBy
 * field: an automated denial records decidedBy: "mode:<name>" — the
 * audit sell. User-level extensions stay on the chain AFTER the mode
 * tiers; a user deny always wins (the chain's deny>ask>allow
 * monotonicity — bypass cannot override an extension deny).
 */

import type { PolicyVerdict } from "@vincemakes/kiso-core";
import type { KisoExtension } from "@vincemakes/kiso-runtime";

export type Mode = "manual" | "default" | "accept-edits" | "plan" | "bypass";

export const MODES: readonly Mode[] = ["manual", "default", "accept-edits", "plan", "bypass"];

/** The read-only tool set (plan): reading is allowed, everything else
 *  denied with the guiding reason. */
const READ_TOOLS = new Set(["read_file", "list_dir", "search_text", "read_skill"]);

let current: Mode = "default";

export function getMode(): Mode {
	return current;
}

export function setMode(m: Mode): void {
	current = m;
}

/** The startup mode: KISO_MODE env (or the --mode flag — the CLI applies
 *  it before the first makeAgent). */
export function modeFromEnv(): Mode {
	const raw = process.env.KISO_MODE;
	const m = MODES.find((x) => x === raw);
	return m ?? "default";
}

/** The per-tier verdict for a tool call — only when this tier is current. */
function tierVerdict(tier: Mode, call: { name: string }): PolicyVerdict {
	if (tier !== current) return { action: "abstain" }; // not our tier — no opinion
	switch (tier) {
		case "manual":
			return { action: "ask" }; // every tool asks
		case "default":
			if (READ_TOOLS.has(call.name)) return { action: "allow" };
			if (call.name === "write_file" || call.name === "edit_file" || call.name === "shell") return { action: "ask" };
			// Abstain (ADR-0042): an extension-provided tool is the
			// EXTENSIONS' business — the tier neither allows nor denies.
			// The chain falls to the ask flow when nobody else speaks, so
			// an uncovered external tool STILL meets the human (the P2
			// finding: "allow"-as-no-opinion auto-approved it).
			return { action: "abstain" };
		case "accept-edits":
			if (READ_TOOLS.has(call.name)) return { action: "allow" };
			if (call.name === "write_file" || call.name === "edit_file") return { action: "allow" };
			if (call.name === "shell") return { action: "ask" };
			return { action: "abstain" }; // see "default"
		case "plan":
			if (READ_TOOLS.has(call.name)) return { action: "allow" };
			return { action: "deny", reason: "plan mode: read-only" };
		case "bypass":
			return { action: "allow" }; // everything — a REAL allow, never an abstain
	}
}

/** The five built-in mode tiers as chain extensions — named "mode:<tier>"
 *  so the runtime's decidedBy records exactly that (the runtime derives
 *  approvalPolicies from extensions[].approvals, tagging each with the
 *  extension name). The CURRENT tier is first: an all-allow chain records
 *  decidedBy = the FIRST SPEAKER, so an auto-allow under the startup mode
 *  names that mode honestly. Order never affects verdicts — the chain is
 *  deny>ask>allow over the SPEAKING verdicts (abstain = no opinion), so a
 *  user extension's deny wins over any mode tier, bypass included (the
 *  monotonicity e2e pins it). */
export function modeExtensions(): readonly KisoExtension[] {
	return [...MODES.filter((m) => m === current), ...MODES.filter((m) => m !== current)].map((m) => ({
		name: `mode:${m}`,
		approvals: [
			{
				decide: async (payload) => tierVerdict(m, { name: payload.name }),
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
