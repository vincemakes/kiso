/**
 * W21 (the v8 approval round) — the approval panel: the bounded block
 * that replaces the running tool's live window while a human-chain
 * approval is pending (the v8 design §3.2). The panel is a VIEW only —
 * the verdict mapping (bare No aborts, No+words continues, esc
 * cancels, the allow-amend words ride the next turn) lives in the CLI,
 * never here (the R3 chain ruling).
 *
 * The block's rows:
 *  - the rule line — the why-asked line, ONE row (never a fold):
 *    `<tool> needs approval — asked by <speaker> · <fix hint>`;
 *  - the title — the toolTarget rendering, ONE row;
 *  - the divider — "─ the full args — never truncated ─";
 *  - the ALWAYS-verbose args (shell = the full command; edit/write =
 *    the untruncated ± diff; other = the full JSON — nothing the human
 *    is asked to approve is ever cut), FOLDED at W−2 and capped at
 *    maxRows−6 with the "└ +N more rows" notice;
 *  - the numbered options — "1 Yes / 2 Yes, don't ask again for <tool>
 *    / 3 No" (the approval flavor) or "1 Yes / 3 No" (the simple
 *    flavor — the trust gate, the uncertain resolutions);
 *  - the affordance — the phase's key hint, ONE row;
 *  - the └ corner.
 * The single-row lines CUT (never fold — the block's height is its row
 * count, the W20 discipline — the #checked throw demands it); the args
 * FOLD (a bounded block's body — content folds, metadata cuts).
 */

import { displayWidth } from "./width.js";
import { cutLine, diffBody, gutterFold, visibleWidth, widthCut } from "./components.js";
import { escapeTerminal, palette } from "./render.js";

export type PanelFlavor = "approval" | "simple";
export type PanelPhase = "options" | "rule" | "amend";
export type PanelSel = 0 | 1 | 2 | 3;

// ── KC3.5 (the ask round): the ask_user panel's TYPES ────────────────
// The ask is the panel machinery generalized, not a second slot: an
// ask view is a PanelView carrying `ask`, and the compositor renders it
// through the SAME panel slot (the rows/lead/status/affordance
// dispatchers live in the tui — this package owns the shapes both
// sides agree on). The renderer and the key routing are the tui's;
// what the human READS is strings.ts's; the flow stays in the cli.

/** One option of a question: the label the human picks, plus an
 *  optional one-line description (the model's own words). */
export interface AskOption {
	readonly label: string;
	readonly description?: string;
}

/** One question: 2-4 options, single- or multi-select, and an optional
 *  ≤12-cell header (the panel's title when present — the schema caps
 *  it so the title never fights the counter for the row). */
export interface AskQuestion {
	readonly question: string;
	readonly header?: string;
	readonly options: readonly AskOption[];
	readonly multiSelect?: boolean;
}

/** The whole ask_user call: 1-4 questions, walked in order. */
export interface AskSpec {
	readonly questions: readonly AskQuestion[];
}

/** One answered question — the three shapes the tool_result carries:
 *  a single choice, a multi-select list, or the typed-in answer. */
export type AskAnswer =
	| { readonly q: string; readonly choice: string }
	| { readonly q: string; readonly choices: readonly string[] }
	| { readonly q: string; readonly custom: string };

/** The ask's outcome: every question answered, or the decline — an
 *  HONEST recorded outcome that names what was skipped, never silence. */
export type AskResult =
	| { readonly answers: readonly AskAnswer[] }
	| { readonly declined: readonly string[] };

/** The ask panel's runtime state — the editor owns and advances it,
 *  the compositor reads it. `picks` and `custom` are per question, so
 *  a walk back (←) shows what was already chosen. */
export interface AskRuntime {
	readonly qIndex: number;
	readonly cursor: number;
	readonly picks: readonly (readonly number[])[];
	readonly custom: readonly (string | null)[];
	readonly phase: "options" | "custom";
}

/** The ALWAYS-verbose args (the panel's body): the untruncated diff
 *  (edit/write), or the full text (shell = the command line, other =
 *  the pretty-printed JSON). The CLI composes them UNTRUNCATED — the
 *  panel renders the expanded diff path (diffBody(diff, W, true)). */
export type PanelArgs =
	| { readonly kind: "diff"; readonly diff: import("./diff.js").DiffLine[] | null }
	| { readonly kind: "text"; readonly lines: readonly string[] };

export interface PanelView {
	/** The flavor — "approval" carries the option-2 rule ("Yes, don't
	 *  ask again"), "simple" (the trust gate, the uncertain resolutions)
	 *  carries only 1 Yes / 3 No. */
	readonly flavor: PanelFlavor;
	/** The tool name — the rule line's first word and the option-2
	 *  rule prefill (the approval flavor). */
	readonly name: string;
	/** The title — the toolTarget rendering ("edit examples/foo.ts"). */
	readonly title: string;
	/** The rule line's "asked by" — the first non-abstain extension
	 *  (the ask verdict's speaker). */
	readonly speaker: string;
	/** The fix hint per speaker (the v8 design §3.5 table). */
	readonly hint?: string;
	/** The options-phase status-left text — the CLI knows the context
	 *  ("▸ run paused", the trust gate's line). */
	readonly statusText: string;
	/** The ALWAYS-verbose args — the full command/content/diff. */
	readonly args: PanelArgs;
	/** The simple flavor's full rule line (the trust/uncertain
	 *  questions) — overrides the why-asked composition. */
	readonly ruleOverride?: string;
	/** The fallback question — the y/n text for the dock-less path
	 *  (a TTY without a dock, or a pipe). */
	readonly fallbackQuestion: string;
	/** KC3.5: the questions, when this view is an ASK. Present = the
	 *  panel renders the ask block and the editor routes the ask keys;
	 *  absent = the approval/simple panel, unchanged. */
	readonly ask?: AskSpec;
}

export type PanelVerdict =
	| { readonly action: "allow"; readonly reason: string }
	| { readonly action: "allow-rule"; readonly rule: string }
	| { readonly action: "deny"; readonly reason: string }
	| { readonly action: "cancel" }
	/** KC3.5: the ask's own verdict — the answers (or the decline) the
	 *  cli hands back to the tool. Only ask views ever produce it, so
	 *  the approval path's switch is untouched. */
	| { readonly action: "answers"; readonly result: AskResult };

/** The bound panel state the compositor reads — the editor owns the
 *  phase/selection state machine and the key routing; the compositor
 *  renders it (the block rows, the input lead, the status/hint). */
export interface PanelState {
	readonly view: PanelView;
	readonly phase: PanelPhase;
	readonly sel: PanelSel;
	/** KC3.5: the ask's walk — present exactly when `view.ask` is. */
	readonly ask?: AskRuntime;
}

/** The rule line's text — the why-asked line (the R3 chain): the tool
 *  name, the first non-abstain speaker, the fix hint (the §3.5 table,
 *  code-accented). The simple flavor carries the CLI's own question
 *  text instead (the trust gate, the uncertain resolutions) — their
 *  titles and args differ, the interaction is identical (§3.6). */
function panelRuleText(view: PanelView): string {
	const p = palette();
	if (view.ruleOverride !== undefined) return escapeTerminal(view.ruleOverride);
	const hint = view.hint;
	const base = `${p.bold}${escapeTerminal(view.name)}${p.reset} ${p.dim}needs approval — asked by${p.reset} ${p.bold}${escapeTerminal(view.speaker)}${p.reset}`;
	return hint ? `${base}${p.dim} ·${p.reset} ${p.code}${escapeTerminal(hint)}${p.reset}` : base;
}

/** The numbered options row — "1 Yes  2 Yes, don't ask again for
 *  <rule>  3 No" (approval) or "1 Yes  3 No" (simple). The row is a
 *  pure SPAN: the block prepends the gutter (the invariant ① test
 *  caught the double-gutter — the block and the row both emitted it).
 *  The option-2 rule name is the ONLY cuttable span: the row's fixed
 *  part (the 1/3 options + the separators + the option-2 prefix) is 45
 *  cells, so the name fits W−45 and cuts with a "…" at W−46 (the
 *  single-row discipline — the row never folds). */
function panelOptionsRow(view: PanelView, sel: PanelSel, W: number): string {
	const p = palette();
	const o1 = sel === 1 ? `${p.bold} 1 Yes${p.reset}` : ` 1 Yes`;
	const o3 = sel === 3 ? `${p.bold} 3 No${p.reset}` : ` 3 No`;
	if (view.flavor === "simple") return `${o1}  ${o3}`;
	// the option-2 span: " 2 Yes, don't ask again for <name>" — the
	// fixed part is 45 (the gutter + the 1/3 options + the separators +
	// the 28-cell prefix); the name cuts to W−46 + "…". The "…" needs
	// its own cell, so the span fits only when W − 46 ≥ 1; below that
	// (W < 47 — incl. the 0.1.42 release-smoke's 40-col winch) the span
	// DROPS: the rule name is the cuttable span, the 1/3 options are
	// the semantics — the approval decision must survive a narrow
	// winch, and invariant ① must never fire on the options row.
	if (W < 47) return cutLine(`${o1}  ${o3}`, Math.max(1, W - 2));
	const name = escapeTerminal(view.name);
	const budget = W - 46;
	const shown = visibleWidth(name) > W - 45 ? `${widthCut(name, budget)}…` : name;
	const o2 = sel === 2 ? `${p.bold} 2 Yes, don't ask again for ${shown}${p.reset}` : ` 2 Yes, don't ask again for ${shown}`;
	return `${o1}  ${o2}  ${o3}`;
}

/** The block's rows — EXACTLY the preview's frame shape, the gutter at
 *  the left edge (the preview's two-space mock indent is its own
 *  styling; the real rows sit at column 1, like every tool cell).
 *  maxRows caps the TOTAL (the args fold; the single-row lines cut). */
export function panelBlockRows(view: PanelView, phase: PanelPhase, sel: PanelSel, W: number, maxRows: number): string[] {
	const p = palette();
	const gutter = `${p.dim}│${p.reset} `;
	const rows: string[] = [];
	rows.push(`${gutter}${cutLine(panelRuleText(view), Math.max(1, W - 2))}`);
	rows.push(`${gutter}${cutLine(`${p.bold}${escapeTerminal(view.title)}${p.reset}`, Math.max(1, W - 2))}`);
	rows.push(`${cutLine(`${p.dim}─ the full args — never truncated ─${p.reset}`, Math.max(1, W - 2))}`);
	// the args — the bounded block's body: fold, then cap. The └ cut is
	// ONE row (the W20 discipline): when the args exceed the budget, one
	// notice row carries the count and where the rest is (the event log).
	const args: string[] =
		view.args.kind === "diff"
			? diffBody(view.args.diff, W, true) // the expanded path — never the tool cell's capped copy
			: view.args.lines.flatMap((line) => gutterFold(`${p.dim}│${p.reset} `, escapeTerminal(line), W));
	const argsBudget = Math.max(1, maxRows - 6);
	let shown: string[];
	if (args.length > argsBudget) {
		const kept = Math.max(0, argsBudget - 1);
		const n = args.length - kept;
		shown = [...args.slice(0, kept), cutLine(`${p.dim}└ +${n} more rows — the full args are in the event log${p.reset}`, Math.max(1, W - 2))];
	} else {
		shown = args;
	}
	rows.push(...shown);
	rows.push(`${gutter}${panelOptionsRow(view, sel, W)}`);
	rows.push(`${gutter}${p.dim}${panelAffordance(view, phase, sel)}${p.reset}`);
	rows.push(`${p.dim}└ ${p.reset}`);
	return rows;
}

/** The input row's lead for the panel's phase (the preview's chrome
 *  rows): the digit leads bold, the rule/feedback leads dim. The rule
 *  lead names the tool (the option-2 prefill), the amend lead the
 *  denial/allowance feedback ("the words ride the verdict"). */
export function panelLead(view: PanelView, phase: PanelPhase, sel: PanelSel): string {
	const p = palette();
	if (phase === "rule") return `${p.dim}2 Yes, don't ask again for ${p.reset}`;
	if (phase === "amend") return `${p.dim}${sel === 3 ? "feedback (deny): " : "feedback (amend): "}${p.reset}`;
	return `${p.bold}${view.flavor === "approval" ? "1-3> " : "1/3> "}${p.reset}`;
}

/** The lead's plain text — the editor's reflow width (the line must
 *  fit the lead + the box's walls). */
export function panelLeadPlain(view: PanelView, phase: PanelPhase, sel: PanelSel): string {
	if (phase === "rule") return "2 Yes, don't ask again for ";
	if (phase === "amend") return sel === 3 ? "feedback (deny): " : "feedback (amend): ";
	return view.flavor === "approval" ? "1-3> " : "1/3> ";
}

export function panelLeadWidth(view: PanelView, phase: PanelPhase, sel: PanelSel): number {
	return displayWidth(panelLeadPlain(view, phase, sel));
}

/** The status row's left text while the panel is up — the phase, not
 *  the CLI's painting status (the compositor derives it from the panel
 *  state; the "▸ run paused" etc. ride the options phase). */
export function panelStatus(view: PanelView, phase: PanelPhase, sel: PanelSel): string {
	if (phase === "rule") return "▸ rule input";
	if (phase === "amend") return sel === 3 ? "▸ deny · the words become the tool_result" : "▸ amend · the words ride the verdict";
	return view.statusText;
}

/** The status row's right-aligned hint while the panel is up — the
 *  phase's keys. The approval flavor gains the tab-amend path; the
 *  simple flavor (the trust/uncertain gates) never does. */
export function panelAffordance(view: PanelView, phase: PanelPhase, sel: PanelSel): string {
	if (phase === "rule") return "enter commits · esc backs out";
	if (phase === "amend") return "enter sends";
	if (view.flavor === "approval") return sel === 0 ? "tab amend · esc cancel" : "enter sends · esc backs out";
	return sel === 0 ? "esc cancel" : "enter sends";
}
