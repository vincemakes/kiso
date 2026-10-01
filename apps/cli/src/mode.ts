/**
 * Modes — the built-in approval tiers, built ON the E1 policy chain
 * (the kernel is untouched). Each tier is an in-process "mode:<name>"
 * extension whose decide() is live — it only speaks when it is the
 * CURRENT tier (otherwise abstain = no opinion, ADR-0042), so /mode
 * switches take effect immediately. The extension NAME rides the runtime's decidedBy
 * field: an automated denial records decidedBy: "mode:<name>" — the
 * audit sell. User-level extensions stay on the chain AFTER the mode
 * tiers; a user deny always wins (the chain's deny>allow>ask
 * monotonicity — full-access cannot override an extension deny).
 *
 * Two questions, two settings (the modes round, 2026-09-30). The TIER
 * answers what the agent may do. The DON'T-ASK SWITCH answers whether
 * kiso may stop for a person, and it composes with every tier: it never
 * grants anything — what would ask is refused, a model's question is not
 * offered, an uncertain execution stays uncertain. The old `dontAsk` tier
 * was that switch welded to default's authority; it is still accepted,
 * and means exactly that.
 */

import type { PolicyCall, PolicyVerdict } from "@vincemakes/kiso-core";
import type { KisoExtension } from "@vincemakes/kiso-runtime";
import { isProtectedWrite } from "./protected-writes.js";

export type Mode = "manual" | "default" | "accept-edits" | "plan" | "full-access";

/** Every tier kiso decides with. */
export const MODES: readonly Mode[] = ["manual", "default", "accept-edits", "plan", "full-access"];

/** The tiers kiso OFFERS a person: the picker, shift+tab, the printed
 *  list, the help. `manual` left the offer at 0.40.0 — a saved allow
 *  outranks its ask, so "asks for every tool" was never quite what it
 *  did — and stays accepted, so no config that names it breaks. */
export const OFFERED_MODES: readonly Mode[] = ["default", "accept-edits", "plan", "full-access"];

/** What a person reads for each tier — the status row, the picker, the
 *  notices. The typed value (config, --mode, KISO_MODE) keeps its hyphen. */
export const MODE_LABEL: Readonly<Record<Mode, string>> = {
	manual: "manual",
	default: "default",
	"accept-edits": "accept edits",
	plan: "plan",
	"full-access": "full access",
};

/** One tier plus, for the one spelling that carried it, the switch. */
export interface ModeSetting {
	readonly mode: Mode;
	readonly dontAsk?: true;
}

/** Every spelling kiso ever accepted keeps its meaning. `bypass` is
 *  full-access's old name. `dontAsk` was a tier: default's decisions with
 *  the switch on — so it still means that, and never full-access with the
 *  switch on (read that way, an old config would gain authority nobody
 *  gave it). */
const OLD_NAMES: ReadonlyMap<string, ModeSetting> = new Map<string, ModeSetting>([
	["bypass", { mode: "full-access" }],
	["dontAsk", { mode: "default", dontAsk: true }],
]);

/** Every value a config, KISO_MODE, --mode or `/mode <name>` accepts. */
export const MODE_VALUES: readonly string[] = [...MODES, ...OLD_NAMES.keys()];

/** A typed tier: its value, its label ("full access"), or an old name. */
export function parseMode(raw: string): ModeSetting | undefined {
	const s = raw.trim();
	const m = MODES.find((x) => x === s || MODE_LABEL[x] === s);
	if (m !== undefined) return { mode: m };
	return OLD_NAMES.get(s);
}

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
	"full-access": "runs without asking — a user deny and the floor still win",
};

/** The switch in one line, for a surface that describes it, under the
 *  same 60-column rule. The /mode panel does not offer it: don't ask is
 *  not a tier, so it never sits beside them (owner, 2026-09-30) — the
 *  panel's header names it when it is on. */
export const DONT_ASK_NOTE = "never asks: what would ask is refused and the run goes on";

/** The read-only tool set (plan): reading is allowed, everything else
 *  denied with the guiding reason. */
const READ_TOOLS = new Set(["read_file", "list_dir", "search_text", "read_skill"]);
/** ADR-0058 (3b, D2): stopping a task this session started asks no one —
 *  stopping is the safe direction — in every tier but manual. */
const STOP_TOOLS = new Set(["task_stop"]);

let current: Mode = "default";

/** The switch. "old-name" is a switch that arrived bundled with the old
 *  `dontAsk` tier: it leaves with the tier, as leaving dontAsk always
 *  gave the asks back. A switch set on its own ("on") outlives every tier
 *  change. */
export type DontAskState = "off" | "on" | "old-name";
let dontAsk: DontAskState = "off";

export function getMode(): Mode {
	return current;
}

/** A tier switch. The switch stays as it is — unless it came with the
 *  old dontAsk tier, which this switch leaves. */
export function setMode(m: Mode): void {
	current = m;
	if (dontAsk === "old-name") dontAsk = "off";
}

/** A typed tier, old names included: `/mode dontAsk` is default with the
 *  switch on, exactly the tier it used to be. */
export function applyModeSetting(s: ModeSetting): void {
	setMode(s.mode);
	if (s.dontAsk === true && dontAsk === "off") dontAsk = "old-name";
}

/** Whether kiso may stop for a person — every ask endpoint reads this. */
export function getDontAsk(): boolean {
	return dontAsk !== "off";
}

export function setDontAsk(on: boolean): void {
	dontAsk = on ? "on" : "off";
}

/** The tier as the status row and the notices name it, with the switch
 *  beside it when it is on. */
export function modeDisplay(): string {
	return `${current === "plan" ? "plan (read-only)" : MODE_LABEL[current]}${dontAsk !== "off" ? " · don't ask" : ""}`;
}

/** One layer's say: what a config file, the environment or the command
 *  line wrote. KisoConfig is one of these. */
export interface ModeLayer {
	readonly mode?: string | undefined;
	readonly dontAsk?: boolean | undefined;
}

export type ModeSource = "flag" | "env" | "project" | "user" | "default";

export interface ModeState {
	readonly mode: Mode;
	readonly dontAsk: DontAskState;
	/** the layer each answer came from — /settings names it */
	readonly from: { readonly mode: ModeSource; readonly dontAsk: ModeSource };
}

/** KISO_MODE and KISO_DONT_ASK. A value kiso cannot read is no value —
 *  the next layer decides, as an unknown KISO_MODE always did. */
export function envModeLayer(env: Readonly<Record<string, string | undefined>> = process.env): ModeLayer {
	const raw = env.KISO_DONT_ASK?.trim().toLowerCase();
	const on = raw === "1" || raw === "true" || raw === "on" ? true : raw === "0" || raw === "false" || raw === "off" ? false : undefined;
	return { ...(env.KISO_MODE !== undefined ? { mode: env.KISO_MODE } : {}), ...(on !== undefined ? { dontAsk: on } : {}) };
}

/**
 * Precedence: flag > env > project config > user config > default, for
 * each answer on its own. The tier comes from the highest layer that
 * names a readable one. The switch comes from the highest layer that
 * either sets it (`--dont-ask`, KISO_DONT_ASK, "dontAsk": true|false) or
 * WON THE TIER with the old name `dontAsk` — an old name's switch counts
 * only where that old name decided the tier. So every combination of old
 * spellings resolves as it did when dontAsk was a tier: a user config
 * saying "dontAsk" under `--mode bypass` still asks, because --mode won.
 */
export function resolveModeLayers(layers: {
	readonly flag?: ModeLayer | null | undefined;
	readonly env?: ModeLayer | null | undefined;
	readonly project?: ModeLayer | null | undefined;
	readonly user?: ModeLayer | null | undefined;
}): ModeState {
	const order: readonly [ModeSource, ModeLayer | null | undefined][] = [
		["flag", layers.flag],
		["env", layers.env],
		["project", layers.project],
		["user", layers.user],
	];
	let tier: { setting: ModeSetting; from: ModeSource } = { setting: { mode: "default" }, from: "default" };
	for (const [from, layer] of order) {
		const setting = layer?.mode === undefined ? undefined : parseMode(layer.mode);
		if (setting !== undefined) {
			tier = { setting, from };
			break;
		}
	}
	for (const [from, layer] of order) {
		if (layer?.dontAsk !== undefined) return { mode: tier.setting.mode, dontAsk: layer.dontAsk ? "on" : "off", from: { mode: tier.from, dontAsk: from } };
		if (from === tier.from && tier.setting.dontAsk === true) return { mode: tier.setting.mode, dontAsk: "old-name", from: { mode: tier.from, dontAsk: from } };
	}
	return { mode: tier.setting.mode, dontAsk: "off", from: { mode: tier.from, dontAsk: "default" } };
}

/** Put a resolved state in force — startup, and again once the project
 *  config is known. */
export function applyModeState(s: ModeState): void {
	current = s.mode;
	dontAsk = s.dontAsk;
}

/** The per-tier verdict for a tool call — only when this tier is current. */
function tierVerdict(tier: Mode, call: PolicyCall, workspaceRoot: () => string): PolicyVerdict {
	if (tier !== current) return { action: "abstain" }; // not our tier — no opinion
	switch (tier) {
		case "manual":
			return { action: "ask" }; // every tool asks
		// The don't-ask switch changes no tier's decision. What it changes is
		// what happens to the chain's final ASK: the CLI denies it at the ask
		// endpoint instead of asking (chat.ts). Not a tier deny — that would
		// outrank every allow, and a saved allow and the read-only shell allow
		// must still allow.
		case "default":
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
		case "full-access":
			return { action: "allow" }; // everything — a REAL allow, never an abstain
	}
}

/** The built-in mode tiers as chain extensions — named "mode:<tier>"
 *  so the runtime's decidedBy records exactly that (the runtime derives
 *  approvalPolicies from extensions[].approvals, tagging each with the
 *  extension name). The CURRENT tier is first: an all-allow chain records
 *  decidedBy = the FIRST SPEAKER, so an auto-allow under the startup mode
 *  names that mode honestly. Order never affects verdicts — the chain is
 *  deny>allow>ask over the SPEAKING verdicts (abstain = no opinion), so a
 *  user extension's deny wins over any mode tier, full-access included
 *  (the monotonicity e2e pins it). */
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
