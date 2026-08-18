/**
 * KC3.5 — the ask view: the model asks the human a real question.
 *
 * The W21 approval panel generalizes rather than duplicates. An ask is a
 * PanelView carrying `ask`, so it rides the EXISTING panel slot: the
 * compositor's live region, the input row's lead, the status/affordance
 * pair, and — the part that matters — the editor's buffer stash/restore
 * and its key precedence (the panel owns the keys; the menu, the history
 * walk and the @ picker never open under it).
 *
 * This module owns three things and nothing else:
 *
 *   1. the ROWS — the question, the ‹ n/m › counter, the numbered
 *      options with their descriptions and selection marks, the
 *      type-your-own line;
 *   2. the pure REDUCER — a key plus a state gives the next state (and,
 *      when the walk ends, the result). No I/O, no editor internals: the
 *      editor feeds it keys and renders what comes back, which is what
 *      makes the whole interaction unit-testable without a terminal;
 *   3. the DISPATCHERS — panelBlockRows/panelLead/panelStatus/
 *      panelAffordance re-exported with the ask branch folded in, so the
 *      compositor and the editor change ONE import line between them and
 *      the panel slot itself stays exactly as W21 built it.
 *
 * What is deliberately NOT here (the round's stop clauses): no partial
 * answer durability (a crash re-presents the WHOLE call — per-toggle
 * durability would need a new durable mechanism), no "chat about this"
 * hand-off, no timeout and no countdown.
 */

import {
	panelAffordance as basePanelAffordance,
	panelBlockRows as basePanelBlockRows,
	panelLead as basePanelLead,
	panelLeadPlain as basePanelLeadPlain,
	panelStatus as basePanelStatus,
	pickAffordance,
	pickBlockRows,
	pickLead,
	pickLeadPlain,
	pickStatus,
	type AskAnswer,
	type AskOption,
	type AskQuestion,
	type AskResult,
	type AskRuntime,
	type AskSpec,
	type PanelPhase,
	type PanelSel,
	type PanelState,
	type PanelView,
	type PickRuntime,
} from "./approval-panel.js";
import { cutLine } from "@vincemakes/kiso-tui-cells/components";
import { escapeTerminal, palette } from "./render.js";

/** The schema's own bounds — the registry refuses anything outside them
 *  (extensions/ask validates; these are the numbers it validates to). */
export const ASK_MAX_QUESTIONS = 4;
export const ASK_MIN_OPTIONS = 2;
export const ASK_MAX_OPTIONS = 4;
export const ASK_HEADER_CAP = 12;

/** The ask panel's opening state: nothing picked, the cursor on the
 *  first option of the first question. */
export function askStart(spec: AskSpec): AskRuntime {
	return {
		qIndex: 0,
		cursor: 0,
		picks: spec.questions.map(() => []),
		custom: spec.questions.map(() => null),
		phase: "options",
	};
}

/** The decline's honest record: every question with its options, so the
 *  model reads what it did NOT get an answer to (frame 4). The SAME
 *  list whether the human pressed esc on question one or question four
 *  — the round declines the CALL, never half of it. */
export function askDeclineList(spec: AskSpec): string[] {
	return spec.questions.map((q) => `${q.question} (${q.options.map((o) => o.label).join(", ")})`);
}

export function askDeclineAll(spec: AskSpec): AskResult {
	return { declined: askDeclineList(spec) };
}

/** The answers collected so far, in the tool_result's own shapes: a
 *  typed answer wins over the picks (the human typed it last), a
 *  multi-select question yields `choices`, a single one `choice`. */
export function askAnswers(spec: AskSpec, state: AskRuntime): AskAnswer[] {
	return spec.questions.map((q, i) => {
		const typed = state.custom[i];
		if (typed !== null && typed !== undefined && typed !== "") return { q: q.question, custom: typed };
		const picked = (state.picks[i] ?? []).map((n) => q.options[n]?.label ?? "");
		return q.multiSelect === true ? { q: q.question, choices: picked } : { q: q.question, choice: picked[0] ?? "" };
	});
}

/** Whether the CURRENT question has something to submit — a pick or a
 *  typed answer. Enter on an empty question is a no-op: the panel never
 *  invents an answer, and never silently skips one. */
function answered(state: AskRuntime, i: number): boolean {
	const typed = state.custom[i];
	return (state.picks[i] ?? []).length > 0 || (typed !== null && typed !== undefined && typed !== "");
}

/** The reducer's outcome: the next state, plus the RESULT when the walk
 *  ended (the last question answered, or the decline). */
export interface AskStep {
	readonly state: AskRuntime;
	readonly result?: AskResult;
}

/** Advance past the current question — the next one, or the end. */
function advance(spec: AskSpec, state: AskRuntime): AskStep {
	const next = state.qIndex + 1;
	if (next >= spec.questions.length) return { state, result: { answers: askAnswers(spec, state) } };
	return { state: { ...state, qIndex: next, cursor: 0, phase: "options" } };
}

function toggle(state: AskRuntime, option: number, multi: boolean): AskRuntime {
	const current = state.picks[state.qIndex] ?? [];
	const next = multi
		? current.includes(option)
			? current.filter((n) => n !== option)
			: [...current, option].sort((a, b) => a - b)
		: [option];
	const picks = state.picks.map((p, i) => (i === state.qIndex ? next : p));
	// a pick supersedes a typed answer for the same question — one
	// question, one answer, and the human's last gesture is the one.
	const custom = state.custom.map((c, i) => (i === state.qIndex ? null : c));
	return { ...state, picks, custom, cursor: option };
}

/**
 * The pure key reducer. `key` is a single logical key: a digit "1".."4",
 * "space", "up"/"down", "left" (walk back), "enter", "t" (type your own),
 * or "esc". The custom phase's TEXT is not routed here — the editor owns
 * the buffer exactly as it does for the rule-input phase, and hands the
 * committed line to `askCommitCustom`.
 */
export function askKey(spec: AskSpec, state: AskRuntime, key: string): AskStep {
	const q = spec.questions[state.qIndex]!;
	const multi = q.multiSelect === true;
	if (state.phase === "custom") {
		// esc backs out of the typing line; enter is the editor's (it
		// carries the text and calls askCommitCustom).
		if (key === "esc") return { state: { ...state, phase: "options" } };
		return { state };
	}
	if (key === "esc") return { state, result: askDeclineAll(spec) };
	if (key === "t") return { state: { ...state, phase: "custom" } };
	if (key === "left") return { state: state.qIndex === 0 ? state : { ...state, qIndex: state.qIndex - 1, cursor: 0 } };
	if (key === "up") return { state: { ...state, cursor: Math.max(0, state.cursor - 1) } };
	if (key === "down") return { state: { ...state, cursor: Math.min(q.options.length - 1, state.cursor + 1) } };
	if (key === "enter") return answered(state, state.qIndex) ? advance(spec, state) : { state };
	// SPACE selects at the cursor and NEVER commits — in either mode. It
	// used to answer-and-advance a single-select question, which made a
	// stray space (the most pressable key there is) an instant answer of
	// whatever the cursor happened to be on. Enter and the digits are the
	// only gestures that commit; space is how you point at something.
	if (key === "space") return { state: toggle(state, state.cursor, multi) };
	const digit = Number.parseInt(key, 10);
	if (Number.isInteger(digit) && digit >= 1 && digit <= q.options.length) {
		const next = toggle(state, digit - 1, multi);
		// single-select answers AND advances — the fast path a human
		// expects; multi-select toggles and waits for enter.
		return multi ? { state: next } : advance(spec, next);
	}
	return { state };
}

/** The typed answer commits: it becomes THE answer for this question
 *  (clearing its picks) and the walk advances. An empty line is a
 *  no-op back to the options — nothing is recorded. */
export function askCommitCustom(spec: AskSpec, state: AskRuntime, text: string): AskStep {
	const trimmed = text.trim();
	if (trimmed === "") return { state: { ...state, phase: "options" } };
	const custom = state.custom.map((c, i) => (i === state.qIndex ? trimmed : c));
	const picks = state.picks.map((p, i) => (i === state.qIndex ? [] : p));
	return advance(spec, { ...state, custom, picks, phase: "options" });
}

// ── the rows ─────────────────────────────────────────────────────────

/** One option row: the number, the selection mark, the label, and the
 *  description after an em dash. The row CUTS (never folds) — the
 *  block's height is its row count, the W20 discipline. */
function optionRow(o: AskOption, n: number, picked: boolean, cursor: boolean, multi: boolean, W: number): string {
	const p = palette();
	const mark = multi ? (picked ? "◉" : "◯") : picked ? "◉" : " ";
	const head = `${cursor ? p.bold : ""} ${n} ${mark} ${escapeTerminal(o.label)}${p.reset}`;
	const body = o.description === undefined ? "" : `${p.dim} — ${escapeTerminal(o.description)}${p.reset}`;
	return cutLine(`${head}${body}`, Math.max(1, W - 2));
}

/** The ask block's rows — the question as the rule line, the header (or
 *  the counter) as the title, the options as the body, and the
 *  type-your-own line last. The shape is the W21 block's: gutter, rule,
 *  title, divider, body, affordance, corner. */
export function askBlockRows(view: PanelView, state: AskRuntime, W: number, maxRows: number): string[] {
	const p = palette();
	const spec = view.ask!;
	const q = spec.questions[state.qIndex]!;
	const multi = q.multiSelect === true;
	const gutter = `${p.dim}│${p.reset} `;
	const counter = spec.questions.length > 1 ? `${p.dim} ‹ ${state.qIndex + 1}/${spec.questions.length} ›${p.reset}` : "";
	const rows: string[] = [];
	rows.push(`${gutter}${cutLine(`${p.bold}${escapeTerminal(q.question)}${p.reset}${counter}`, Math.max(1, W - 2))}`);
	const header = q.header === undefined ? "the question" : escapeTerminal(q.header.slice(0, ASK_HEADER_CAP));
	rows.push(`${gutter}${cutLine(`${p.dim}${header}${p.reset}`, Math.max(1, W - 2))}`);
	rows.push(cutLine(`${p.dim}─ ${multi ? "pick any — space toggles" : "pick one"} ─${p.reset}`, Math.max(1, W - 2)));
	const picks = state.picks[state.qIndex] ?? [];
	const body = q.options.map((o, i) => `${gutter}${optionRow(o, i + 1, picks.includes(i), state.cursor === i, multi, W)}`);
	const typed = state.custom[state.qIndex];
	body.push(
		`${gutter}${cutLine(
			typed === null || typed === undefined
				? `${p.dim} t   type your own answer${p.reset}`
				: ` t ◉ ${escapeTerminal(typed)}`,
			Math.max(1, W - 2),
		)}`,
	);
	// the bounded block: the options fold nothing and cut individually,
	// so the cap drops whole rows with the W21 notice row.
	const budget = Math.max(1, maxRows - 5);
	if (body.length > budget) {
		const kept = Math.max(0, budget - 1);
		rows.push(...body.slice(0, kept));
		rows.push(cutLine(`${p.dim}└ +${body.length - kept} more rows — the full question is in the event log${p.reset}`, Math.max(1, W - 2)));
	} else {
		rows.push(...body);
	}
	rows.push(`${gutter}${p.dim}${askAffordance(state)}${p.reset}`);
	// TUI2-R1.5 11 (VD-13), shared with the approval panel: a real bottom RULE, in the block's own edge
	// vocabulary — the same box-drawing run its divider already uses —
	// anchored at the gutter column. It used to be `\u2514 `: a two-cell stub
	// floating at column 1, with no rule running from it and no corner
	// above it to answer. Worse, `\u2514 ` is the cut-notice prefix everywhere
	// else in the product, so a CAPPED panel emitted two elbow rows in a
	// row meaning entirely different things. The rule reads as an edge,
	// and the cut notice above it reads as a notice.
	rows.push(`${p.dim}\u2514${"\u2500".repeat(Math.max(0, W - 1))}${p.reset}`);
	return rows;
}

/** The status row's right-hand hint — the phase's keys. */
export function askAffordance(state: AskRuntime): string {
	if (state.phase === "custom") return "enter answers · esc backs out";
	return state.qIndex > 0 ? "1-4 pick · t type · ← back · esc decline" : "1-4 pick · t type · esc decline";
}

/** The status row's left text — the ask's own line, with the walk. */
export function askStatus(view: PanelView, state: AskRuntime): string {
	const total = view.ask!.questions.length;
	return total > 1 ? `▸ question ${state.qIndex + 1} of ${total}` : "▸ a question for you";
}

/** The input row's lead: the digit lead while picking, the typing lead
 *  in the custom phase (the rule-input phase's shape, reused). */
export function askLeadPlain(state: AskRuntime): string {
	return state.phase === "custom" ? "your answer: " : "1-4> ";
}

// ── the dispatchers: the panel slot, with the ask branch folded in ────

export function panelBlockRows(view: PanelView, phase: PanelPhase, sel: PanelSel, W: number, maxRows: number, ask?: AskRuntime, pick?: PickRuntime): string[] {
	if (view.pick !== undefined && pick !== undefined) return pickBlockRows(view, pick, W, maxRows);
	if (view.ask !== undefined && ask !== undefined) return askBlockRows(view, ask, W, maxRows);
	return basePanelBlockRows(view, phase, sel, W, maxRows);
}

export function panelLead(view: PanelView, phase: PanelPhase, sel: PanelSel, ask?: AskRuntime, pick?: PickRuntime): string {
	const p = palette();
	if (view.pick !== undefined && pick !== undefined) return pickLead(view, pick);
	if (view.ask !== undefined && ask !== undefined) return `${p.bold}${askLeadPlain(ask)}${p.reset}`;
	return basePanelLead(view, phase, sel);
}

export function panelLeadPlain(view: PanelView, phase: PanelPhase, sel: PanelSel, ask?: AskRuntime, pick?: PickRuntime): string {
	if (view.pick !== undefined && pick !== undefined) return pickLeadPlain(view, pick);
	if (view.ask !== undefined && ask !== undefined) return askLeadPlain(ask);
	return basePanelLeadPlain(view, phase, sel);
}

export function panelStatus(view: PanelView, phase: PanelPhase, sel: PanelSel, ask?: AskRuntime, pick?: PickRuntime): string {
	if (view.pick !== undefined && pick !== undefined) return pickStatus(view);
	if (view.ask !== undefined && ask !== undefined) return askStatus(view, ask);
	return basePanelStatus(view, phase, sel);
}

export function panelAffordance(view: PanelView, phase: PanelPhase, sel: PanelSel, ask?: AskRuntime, pick?: PickRuntime): string {
	if (view.pick !== undefined && pick !== undefined) return pickAffordance(pick);
	if (view.ask !== undefined && ask !== undefined) return askAffordance(ask);
	return basePanelAffordance(view, phase, sel);
}

/** The whole panel state in one call — the compositor's four reads share
 *  one source, so an ask can never render half as an approval (TUI2-R2
 *  ④: nor a pick as either). */
export const panelRowsOf = (s: PanelState, W: number, maxRows: number): string[] =>
	panelBlockRows(s.view, s.phase, s.sel, W, maxRows, s.ask, s.pick);
export const panelLeadOf = (s: PanelState): string => panelLead(s.view, s.phase, s.sel, s.ask, s.pick);
export const panelStatusOf = (s: PanelState): string => panelStatus(s.view, s.phase, s.sel, s.ask, s.pick);
export const panelAffordanceOf = (s: PanelState): string => panelAffordance(s.view, s.phase, s.sel, s.ask, s.pick);

// ── the view: what the human reads when the model asks ────────────────

/** The ask's PanelView. The dock-less fallback question is HONEST: a
 *  terminal without a panel cannot walk options, so it says the ask is
 *  being declined rather than pretending y/n answered it. */
export function askView(spec: AskSpec): PanelView {
	const first = spec.questions[0]!;
	return {
		flavor: "simple",
		name: "ask_user",
		title: first.header ?? first.question,
		speaker: "kiso",
		statusText: "▸ a question for you",
		args: { kind: "text", lines: askDeclineList(spec) },
		fallbackQuestion: `⚠ ${escapeTerminal(first.question)} — this terminal cannot show the option panel; the question is declined `,
		ask: spec,
	};
}

export type { AskAnswer, AskOption, AskQuestion, AskResult, AskRuntime, AskSpec };
