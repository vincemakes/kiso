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
	panelBlockLayout,
	type SaferRuntime,
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
	type PanelState,
	type PanelView,
	type PickRuntime,
} from "./approval-panel.js";
import { cutLine, selectionBar, visibleWidth, widthCut } from "@vincemakes/kiso-tui-cells/components";
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
/** REL-0152-D3 — the index of the type-your-own row: one past the last
 *  option, which is where `askBlockRows` draws it. Options and this row
 *  are one list to the eye, so they are one list to the cursor. */
const customRow = (q: AskQuestion): number => q.options.length;

/** REL-0152-D4: is the cursor on the type-your-own row? The editor asks
 *  before it decides what a printable key means — on this row a key is
 *  the first character of an answer, everywhere else it is a shortcut.
 *  Exported so that rule lives on ONE definition of the row. */
export function askOnCustomRow(spec: AskSpec, state: AskRuntime): boolean {
	const q = spec.questions[state.qIndex];
	return q !== undefined && state.phase === "options" && state.cursor === customRow(q);
}

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
	// `t` is the shortcut from anywhere in the list; `type` is the
	// REL-0152-D4 gesture — the editor sends it when the cursor is
	// already on the custom row and a printable key arrives, so the
	// keystroke that opened the phase is also its first character.
	if (key === "t" || key === "type") return { state: { ...state, phase: "custom" } };
	if (key === "left") return { state: state.qIndex === 0 ? state : { ...state, qIndex: state.qIndex - 1, cursor: 0 } };
	if (key === "up") return { state: { ...state, cursor: Math.max(0, state.cursor - 1) } };
	// REL-0152-D3: the cursor range includes the type-your-own row, which
	// askBlockRows renders as the list's last item. It used to stop one
	// short, so a row the eye counts as fourth could not be reached by
	// the key that walks the list — the affordance promised a list and
	// delivered four of its five rows.
	if (key === "down") return { state: { ...state, cursor: Math.min(customRow(q), state.cursor + 1) } };
	if (key === "enter") {
		// on the custom row, enter is the way in — the same gesture the
		// row's neighbours answer with.
		if (state.cursor === customRow(q)) return { state: { ...state, phase: "custom" } };
		return answered(state, state.qIndex) ? advance(spec, state) : { state };
	}
	// SPACE selects at the cursor and NEVER commits — in either mode. It
	// used to answer-and-advance a single-select question, which made a
	// stray space (the most pressable key there is) an instant answer of
	// whatever the cursor happened to be on. Enter and the digits are the
	// only gestures that commit; space is how you point at something.
	// space points at an option; on the custom row it opens the typing
	// phase rather than toggling an option that is not there.
	if (key === "space") return state.cursor === customRow(q) ? { state: { ...state, phase: "custom" } } : { state: toggle(state, state.cursor, multi) };
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

/**
 * One option row: the cursor arrow, the number, the selection mark, the
 * label, and the description in its own RIGHT COLUMN. The row CUTS
 * (never folds) — the block's height is its row count, the W20
 * discipline.
 *
 * R2 (design §7.5) — two changes, both about what survives:
 *
 *  - the cursor carries `→` as well as the bar. The bar is the loud
 *    signal and the arrow is the durable one: strip every escape and the
 *    row still says which option the cursor is on, which is law 1.3's
 *    test applied to a selection rather than to an outcome.
 *  - the description leaves the em dash and takes a column. Run-on
 *    `label — description` makes the labels — the thing being chosen
 *    between — unscannable, because each one starts at a column the
 *    previous row's length decided. `stop` is computed ONCE over the
 *    whole option list by the caller, so the column is a property of
 *    the list and not of the row.
 *
 * A narrow block has no room for two columns; `stop` arrives as 0 and
 * the em-dash form is what it degrades to.
 */
function optionRow(o: AskOption, n: number, picked: boolean, cursor: boolean, multi: boolean, W: number, stop = 0): string {
	const p = palette();
	const mark = multi ? (picked ? "◉" : "◯") : picked ? "◉" : " ";
	const lead = askOptionLead(o, n, mark, cursor);
	const head = `${cursor ? p.bold : ""}${lead}${p.reset}`;
	const room = Math.max(1, W - 2);
	let body: string;
	if (o.description === undefined) body = "";
	else if (stop > 0) {
		const desc = widthCut(escapeTerminal(o.description), Math.max(0, room - stop));
		body = `${" ".repeat(Math.max(1, stop - visibleWidth(lead)))}${p.dim}${desc}${p.reset}`;
	} else body = `${p.dim} — ${escapeTerminal(o.description)}${p.reset}`;
	const text = cutLine(`${head}${body}`, Math.max(1, W - 2));
	// R2: the cursor is a FULL-ROW bar, the same one the approval panel
	// has had since R1.5 ⑧ — "a two-cell marker in an eighty-column row is
	// a selection you have to hunt for". This panel was carrying bold and
	// nothing else, which on a white terminal is close to invisible. One
	// ruling, applied in the second place it was always about.
	return cursor ? selectionBar(text, visibleWidth(text), W) : ` ${text}`; // R2: the frame is a rule, so a row is just indented
}

/** The row's left span, PLAIN — the one place its shape is written, so
 *  the column arithmetic below and the row above cannot disagree about
 *  how wide it is. The arrow's cell is spent on every row so the digit
 *  column does not move as the cursor walks. */
function askOptionLead(o: AskOption, n: number, mark: string, cursor: boolean): string {
	return `${cursor ? "→" : " "} ${n} ${mark} ${escapeTerminal(o.label)}`;
}

/** Below this many cells a right column is not a column, it is a
 *  three-word stub — the em-dash form carries more of the sentence. */
const ASK_DESC_MIN = 18;

/** The description column, computed over the WHOLE list: two cells past
 *  the widest label, never past the half-width, and 0 (meaning "no
 *  column, use the em dash") when what is left would not hold a
 *  readable description. */
export function askDescriptionStop(q: AskQuestion, W: number): number {
	const multi = q.multiSelect === true;
	if (!q.options.some((o) => o.description !== undefined)) return 0;
	const widest = Math.max(...q.options.map((o, i) => visibleWidth(askOptionLead(o, i + 1, multi ? "◯" : " ", false))));
	const room = Math.max(1, W - 2);
	const stop = widest + 2;
	if (stop > Math.floor(room / 2) || room - stop < ASK_DESC_MIN) return 0;
	return stop;
}

/** The ask block's rows — the question as the rule line, the header (or
 *  the counter) as the title, the options as the body, and the
 *  type-your-own line last. R2: the shape is the RULE's — rule,
 *  title, header, body, affordance, rule. */
export function askBlockRows(view: PanelView, state: AskRuntime, W: number, maxRows: number): string[] {
	const p = palette();
	const spec = view.ask!;
	const q = spec.questions[state.qIndex]!;
	const multi = q.multiSelect === true;
	const counter = spec.questions.length > 1 ? `${p.dim} ‹ ${state.qIndex + 1}/${spec.questions.length} ›${p.reset}` : "";
	const rows: string[] = [];
	// R2: the same dashed rule the composer and the approval panel use.
	rows.push(`${p.dim}${"\u2500".repeat(Math.max(0, W))}${p.reset}`);
	rows.push(`  ${cutLine(`${p.bold}${escapeTerminal(q.question)}${p.reset}${counter}`, Math.max(1, W - 2))}`);
	const header = q.header === undefined ? "the question" : escapeTerminal(q.header.slice(0, ASK_HEADER_CAP));
	// R2: the divider row is gone (the opening rule says a block starts
	// here), but the multi-select gesture it carried is INFORMATION and
	// rides the header instead — dropping it would have been a regression
	// wearing a restyle's clothes.
	const gesture = multi ? `${p.dim} · pick any — space toggles${p.reset}` : "";
	rows.push(`  ${cutLine(`${p.dim}${header}${p.reset}${gesture}`, Math.max(1, W - 2))}`);
	rows.push("");
	const picks = state.picks[state.qIndex] ?? [];
	const stop = askDescriptionStop(q, W);
	const body = q.options.map((o, i) => optionRow(o, i + 1, picks.includes(i), state.cursor === i, multi, W, stop));
	// REL-0152-D3: the row is part of the list, so it carries the same
	// cursor affordance the options do. Dim-always made a reachable row
	// look like a footnote.
	const typed = state.custom[state.qIndex];
	const onCustom = state.cursor === customRow(q);
	// REL-0152-D4: while the phase is OPEN the row becomes the answer's
	// box — a faint placeholder standing where the text will land, so an
	// empty typing phase looks like somewhere to type instead of looking
	// like nothing happened. The placeholder is dim and the answer is
	// not: the two can never be mistaken for each other.
	const typingHere = state.phase === "custom";
	// R2: the custom row is one of the list's rows, so it wears the
	// list's cursor — the arrow AND the bar. It was carrying bold alone,
	// which is the exact invisibility §7.5 was written about, on the one
	// row a keyboard user reaches last.
	const customLead = `${onCustom ? "→" : " "} t `;
	const customText = cutLine(
		typed !== null && typed !== undefined
			? `${onCustom || typingHere ? p.bold : ""}${customLead}◉ ${escapeTerminal(typed)}${p.reset}`
			: typingHere
				? `${p.bold}${customLead}▸${p.reset} ${p.dim}type your answer — enter sends, esc backs out${p.reset}`
				: `${onCustom ? p.bold : p.dim}${customLead}  type your own answer${p.reset}`,
		Math.max(1, W - 2),
	);
	body.push(onCustom ? selectionBar(customText, visibleWidth(customText), W) : ` ${customText}`);
	// the bounded block: the options fold nothing and cut individually,
	// so the cap drops whole rows with the W21 notice row.
	// R2: SIX rows of frame — the block opens with a rule as well as
	// closing with one, and the divider became a blank.
	const budget = Math.max(1, maxRows - 6);
	if (body.length > budget) {
		const kept = Math.max(0, budget - 1);
		rows.push(...body.slice(0, kept));
		rows.push(cutLine(`${p.dim}└ +${body.length - kept} more rows — the full question is in the event log${p.reset}`, Math.max(1, W - 2)));
	} else {
		rows.push(...body);
	}
	rows.push(`  ${p.dim}${askAffordance(state)}${p.reset}`);
	// R2, shared with the approval panel: the block closes with the SAME
	// dashed rule it opened with, and the same one the composer uses.
	// TUI2-R1.5 ⑪ had already replaced a two-cell `\u2514 ` stub with a
	// real rule for the reason that stub read as the cut-notice prefix it
	// collides with; this keeps that finding and only changes which rule.
	rows.push(`${p.dim}${"\u2500".repeat(Math.max(0, W))}${p.reset}`);
	return rows;
}

/** The status row's right-hand hint — the phase's keys. */
export function askAffordance(state: AskRuntime): string {
	if (state.phase === "custom") return "enter answers · esc backs out";
	return state.qIndex > 0 ? "1-4 pick · t type · ← back · esc decline" : "1-4 pick · t type · esc decline";
}

/** The status row's left text — the ask's own line, with the walk. */
export function askStatus(view: PanelView, state: AskRuntime): string {
	// R2: the status says the DURABLE thing. Every other agent's option
	// panel dies with its process; this one is a fact in the event log, so
	// killing kiso and coming back brings the question with it and never
	// re-asks an answered one (ADR-0051 §8). The screen had never said so.
	// It costs a status string and it is the cheapest claim in the product
	// that no competitor can copy without building the log first.
	const total = view.ask!.questions.length;
	const where = total > 1 ? `question ${state.qIndex + 1} of ${total}` : "a question for you";
	return `⏸ ${where} · answers are durable facts`;
}

/** The input row's lead: the digit lead while picking, the typing lead
 *  in the custom phase (the rule-input phase's shape, reused). */
export function askLeadPlain(state: AskRuntime): string {
	// REL-0152-D3: "1-4> " was hard-coded and wrong twice over — it named
	// a range even when there were two options, and it excluded the
	// type-your-own row the list shows.
	return state.phase === "custom" ? "your answer: " : "pick> ";
}

// ── the dispatchers: the panel slot, with the ask branch folded in ────

export function panelBlockRows(view: PanelView, phase: PanelPhase, cursor: number, W: number, maxRows: number, ask?: AskRuntime, pick?: PickRuntime, note?: string, safer?: SaferRuntime): string[] {
	if (view.pick !== undefined && pick !== undefined) return pickBlockRows(view, pick, W, maxRows);
	if (view.ask !== undefined && ask !== undefined) return askBlockRows(view, ask, W, maxRows);
	return basePanelBlockRows(view, phase, cursor, W, maxRows, note, safer);
}

export function panelLead(view: PanelView, phase: PanelPhase, cursor: number, ask?: AskRuntime, pick?: PickRuntime): string {
	const p = palette();
	if (view.pick !== undefined && pick !== undefined) return pickLead(view, pick);
	if (view.ask !== undefined && ask !== undefined) return `${p.bold}${askLeadPlain(ask)}${p.reset}`;
	return basePanelLead(view, phase, cursor);
}

export function panelLeadPlain(view: PanelView, phase: PanelPhase, cursor: number, ask?: AskRuntime, pick?: PickRuntime): string {
	if (view.pick !== undefined && pick !== undefined) return pickLeadPlain(view, pick);
	if (view.ask !== undefined && ask !== undefined) return askLeadPlain(ask);
	return basePanelLeadPlain(view, phase, cursor);
}

export function panelStatus(view: PanelView, phase: PanelPhase, cursor: number, ask?: AskRuntime, pick?: PickRuntime): string {
	if (view.pick !== undefined && pick !== undefined) return pickStatus(view);
	if (view.ask !== undefined && ask !== undefined) return askStatus(view, ask);
	return basePanelStatus(view, phase, cursor);
}

export function panelAffordance(view: PanelView, phase: PanelPhase, cursor: number, ask?: AskRuntime, pick?: PickRuntime, safer?: SaferRuntime): string {
	if (view.pick !== undefined && pick !== undefined) return pickAffordance(pick);
	if (view.ask !== undefined && ask !== undefined) return askAffordance(ask);
	return basePanelAffordance(view, phase, cursor, safer);
}

/** The whole panel state in one call — the compositor's four reads share
 *  one source, so an ask can never render half as an approval (TUI2-R2
 *  ④: nor a pick as either). */
export const panelRowsOf = (s: PanelState, W: number, maxRows: number): string[] =>
	panelBlockRows(s.view, s.phase, s.cursor, W, maxRows, s.ask, s.pick, s.note, s.safer);

/**
 * TUI2-R3v2 ② — the rows AND where the clickable ones are, from ONE
 * call.
 *
 * The compositor needs both and must not compute the second from the
 * first: the args cap, the note row and the option window all move the
 * list, so a hit-test that re-derived the offset would drift from the
 * picture exactly when the block is under pressure — which is when a
 * misrouted click is most expensive.
 *
 * `options` is null for the ask and pick flavors: their rows are placed
 * by their own renderers, and this round does not claim a click on them
 * (the enable/disable invariant covers those surfaces; the gesture does
 * not). A null here means every click is inert, which is the safe way
 * to not-implement something.
 */
export const panelFrameOf = (
	s: PanelState,
	W: number,
	maxRows: number,
): { rows: string[]; options: { offset: number; count: number; first: number } | null } => {
	if (s.view.pick !== undefined || s.view.ask !== undefined) return { rows: panelRowsOf(s, W, maxRows), options: null };
	const layout = panelBlockLayout(s.view, s.phase, s.cursor, W, maxRows, s.note, s.safer);
	return {
		rows: layout.rows as string[],
		options: layout.count === 0 ? null : { offset: layout.offset, count: layout.count, first: layout.first },
	};
};
export const panelLeadOf = (s: PanelState): string => panelLead(s.view, s.phase, s.cursor, s.ask, s.pick);
export const panelStatusOf = (s: PanelState): string => panelStatus(s.view, s.phase, s.cursor, s.ask, s.pick);
export const panelAffordanceOf = (s: PanelState): string => panelAffordance(s.view, s.phase, s.cursor, s.ask, s.pick, s.safer);

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
		statusText: "⏸ a question for you",
		args: { kind: "text", lines: askDeclineList(spec) },
		fallbackQuestion: `⚠ ${escapeTerminal(first.question)} — this terminal cannot show the option panel; the question is declined `,
		ask: spec,
	};
}

export type { AskAnswer, AskOption, AskQuestion, AskResult, AskRuntime, AskSpec };
