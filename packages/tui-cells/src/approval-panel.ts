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
import { atEmbed, bandKeyRow, bandVisible, bandWindow, boxBottom, cutLine, diffBody, foldAtSpaces, foldWords, goldHits, gutterFold, moreMark, selectionBar, visibleWidth, widthCut } from "./components.js";
// TUI2-R2pre ④: strings.js takes only a TYPE from this module, so the
// import is erased at compile time and no runtime cycle exists.
import { bandHeader, displayVerb } from "./strings.js";
import { escapeTerminal, palette } from "./render.js";

export type PanelFlavor = "approval" | "simple";
/**
 * TUI2-R3v2 ① — two phases, not three.
 *
 * The "rule" phase is gone. It existed because option 2 used to hand the
 * human a prefilled text box to edit the rule in, which implied the rule
 * could be anything they typed. It could not: the generated extension
 * matches on `call.name` and nothing else, so every character typed
 * beyond the tool name either did nothing or silently produced a rule
 * that never fired. Option 2 now grants exactly what the machinery
 * supports, on the keypress, and the copy says exactly that.
 */
export type PanelPhase = "options" | "amend" | "asking" | "safer";

/**
 * TUI2-R3v2 ③ — one safer alternative the model proposed.
 *
 * Two fields and no more. The command is what would actually run, so it
 * is the row's subject; `why` is the one-line plain-language reason,
 * because a list of three shell commands with no explanation asks the
 * human to diff them in their head — which is the work the feature
 * exists to remove.
 */
export interface SaferOption {
	readonly command: string;
	readonly why: string;
}

/** TUI2-R3v2 ③: the safer list's own walk — the options the model gave
 *  and the bar's place in them. The LAST row (the way back) is not an
 *  option and is not in this array; it is rendered after them and its
 *  index is `options.length`. */
export interface SaferRuntime {
	readonly options: readonly SaferOption[];
	readonly cursor: number;
}

/** The copy a failed ask owes the human. One line, dim, and it says what
 *  is still true rather than what went wrong: the original choices are
 *  all still there, which is the only thing they need to know to keep
 *  going. */
export const SAFER_DEGRADED = "couldn't get safer options — the original choices stand";

/**
 * R3v2-F1 — the same sentence, for the one failure the reply's own text
 * can PROVE.
 *
 * The unqualified line is true of every failure the ask has, which is
 * exactly why it explains nothing when the cause was knowable. A reply
 * the token budget cut in half is knowable: the JSON opens and never
 * closes. So that case gets the cause in a parenthesis and keeps
 * everything else — one line, dim, still leading with what is still
 * true — because the human is mid-approval and the shape of the sentence
 * is what they have already learned to read.
 */
export const SAFER_DEGRADED_TRUNCATED = "couldn't get safer options (the reply was cut short) — the original choices stand";

/**
 * R3v2-F1 — a failure that knows why it failed.
 *
 * `truncated` is the only cause the caller can demonstrate from the
 * text, and it is deliberately the only member: a diagnosis the product
 * cannot prove is worse than no diagnosis, so every other failure stays
 * the unqualified line rather than growing a guess.
 */
export interface SaferFailure {
	readonly reason: "truncated";
}

/**
 * R3v2-F1 — what the safer-options provider hands back.
 *
 * A list is the answer. `null` is a failure with nothing to add, and is
 * still the whole contract for any caller that has nothing to add — the
 * widening is additive, so an existing provider's behaviour is
 * byte-identical. A SaferFailure is a failure that can name its cause.
 */
export type SaferAnswer = readonly SaferOption[] | SaferFailure | null;

/** R3v2-F1: the line a failed ask owes the human — the unqualified one,
 *  unless the answer named a cause. The panel asks this instead of
 *  reaching for a constant, so the choice of sentence lives with the
 *  sentences. */
export function saferDegradedNote(answer: SaferAnswer): string {
	const failure = answer === null || Array.isArray(answer) ? null : (answer as SaferFailure);
	return failure?.reason === "truncated" ? SAFER_DEGRADED_TRUNCATED : SAFER_DEGRADED;
}

/** The row that returns to state 1. Rendered last, always present — an
 *  alternatives list you cannot back out of would be a trap. */
export const SAFER_BACK = "back to the original choices";

/** What an option DOES — the verdict channel it commits to. The label is
 *  what the human reads; the kind is what the editor routes on, so the
 *  copy can change without touching a single branch. */
export type PanelOptionKind = "allow" | "rule" | "safer" | "deny";

export interface PanelOption {
	readonly kind: PanelOptionKind;
	readonly label: string;
}

/**
 * The options a view offers, IN ROW ORDER — and the order is the whole
 * contract: the index is the digit, the digit is the row, and the row is
 * what a mouse click lands on. One list, read by the renderer, the key
 * router and the hit-test, so those three can never disagree about what
 * option 3 is.
 *
 * The approval flavor's copy is the v4 frames', with ONE correction.
 * The frame said "don't ask again for <tool> this session"; the rule
 * machinery (addDontAskAgainRule) writes a generated extension file that
 * outlives the process and matches on the TOOL NAME. "This session"
 * would have understated a durable grant — the one direction a
 * permission prompt must never be wrong in — so the scope claim is
 * dropped rather than invented. The revocation path is the file itself,
 * which the generated header documents.
 */
export function panelOptions(view: PanelView): readonly PanelOption[] {
	if (view.flavor === "simple") {
		const [yes, no] = view.simpleOptions ?? ["Yes", "No"];
		return [
			{ kind: "allow", label: yes },
			{ kind: "deny", label: no },
		];
	}
	return [
		{ kind: "allow", label: "Yes, run it" },
		{ kind: "rule", label: `Yes, and don't ask again for ${displayVerb(view.name)}` },
		{ kind: "safer", label: "Show me safer ways to do this" },
		{ kind: "deny", label: "No — let me tell it what to do instead" },
	];
}

/**
 * TUI2-R3v2 ④ — the deletion-risk hint: four patterns, and nothing else.
 *
 * The owner's ruling narrowed this to commands where UNDO DOES NOT
 * EXIST. That is the whole selection criterion, and it is what makes the
 * line worth reading: a warning on every dangerous command teaches the
 * eye to skip warnings, and the eye is the only thing standing between
 * the human and the side effect.
 *
 * So `dd if=/dev/zero of=/dev/sda` gets nothing. It is more destructive
 * than anything in this table and it is not in it, because the moment
 * the rules start guessing they start being wrong in both directions —
 * missing the real ones and crying wolf on `git checkout main`. Four
 * shapes, matched exactly, no inference.
 *
 * The rm case NAMES ITS TARGETS. "This deletes files" is a sentence
 * about the command's category; "(node_modules, dist)" is the thing the
 * human is actually deciding about, and it is the difference between a
 * hint and a label.
 *
 * Local string rules: zero requests, zero rent, and it never blocks —
 * the hint is a sentence beside the command, never a gate in front of
 * it. The mode moat and the safe-defaults moat are the teeth; this is
 * the eyes.
 */
export function deletionRiskHint(command: string): string | null {
	// a compound command's risk can be its SECOND half ("npm run clean &&
	// git clean -fd"), so the segments are scanned in order and the FIRST
	// match wins: one line, never a stack of them.
	for (const raw of command.split(/&&|\|\||[;|]/)) {
		const segment = raw.trim();
		if (segment === "") continue;
		const hint = segmentRisk(segment);
		if (hint !== null) return hint;
	}
	return null;
}

function segmentRisk(segment: string): string | null {
	const words = segment.split(/\s+/);
	const verb = words[0];
	if (verb === "rm") {
		// -rf in any spelling or order (-rf, -fr, -r -f), because the shell
		// accepts all of them and the human meant the same thing by each.
		const flags = words.slice(1).filter((w) => /^-[a-zA-Z]+$/.test(w));
		const letters = flags.join("");
		if (!letters.includes("r") || !letters.includes("f")) return null;
		const targets = words.slice(1).filter((w) => !/^-/.test(w));
		return targets.length === 0 ? "deletes files permanently" : `deletes files permanently (${targets.join(", ")})`;
	}
	if (verb !== "git") return null;
	const sub = words[1];
	// `git checkout -- <paths>` discards; `git checkout <branch>` does not,
	// and conflating them would put a red line on the most ordinary command
	// in the product.
	if (sub === "checkout" && words.includes("--")) return "discards your uncommitted changes — unrecoverable";
	if (sub === "reset" && words.includes("--hard")) return "throws away commits and working changes";
	// `git clean -n` is a DRY RUN and is the reason this checks for the f
	// rather than for the command.
	if (sub === "clean") {
		const letters = words
			.slice(2)
			.filter((w) => /^-[a-zA-Z]+$/.test(w))
			.join("");
		if (letters.includes("f")) return "deletes untracked files permanently";
	}
	return null;
}

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

// ── TUI2-R2 ④ (the navigation round): the PICK panel's types ────────
// A third payload in the same slot, for the same reason the ask was a
// second one: the block, the lead, the status and the affordance are
// already solved here, and a picker with machinery of its own would be
// a second set of geometry bugs. `pick` present = the panel renders the
// pick block and the editor routes the pick keys; absent = untouched.

/** One thing that can be picked: what it is, and what qualifies it. */
export interface PickOption {
	readonly label: string;
	/** the dim qualifier ("profile: ds \u00b7 current") \u2014 what tells two
	 *  similar rows apart */
	readonly note?: string;
	/** OR-7 — the SECOND axis. The model's NATIVE levels in vendor order,
	 *  from the registry. Absent = this option has no second axis and the
	 *  row renders exactly as it did before. */
	readonly levels?: readonly string[];
	/** where the level cursor starts. UNDEFINED is a real state, not a
	 *  missing value: a row whose registry default is null (the page
	 *  states none) marks nothing, and enter applies the profile alone.
	 *  The panel never invents a default. */
	readonly level?: number;
	/** indexes forbidden for the current thinking mode. The cursor never
	 *  rests on one \u2014 see `enabledLevel`. */
	readonly disabled?: readonly number[];
	/** shown after the strip when the cursor did NOT land where the
	 *  previous selection asked ("effort xhigh \u2192 high: the nearest this
	 *  model supports"). The caller's sentence, reproduced verbatim. */
	readonly levelNote?: string;
	/** Graphite R3e: what the second axis IS, named on its key hint
	 *  (`←→ mode`); absent, it is the model's `effort`. P3: a named axis is
	 *  the row's own value, so its strip carries no label of its own. */
	readonly axisLabel?: string;
	/** Graphite P3: the columns after the label (a profile's host and state,
	 *  a setting's value and source), measured over EVERY option so nothing
	 *  moves as the cursor or the filter does. Absent, the `note` is the one
	 *  column. */
	readonly cols?: readonly string[];
	/** Graphite P3: what the selected row OPENS into, on the same wash (the
	 *  /resume shape) — what the columns cannot hold: why a profile cannot
	 *  run, how a config setting changes. After the level strip when there
	 *  is one, and it gives way first. */
	readonly opened?: string;
	/** Graphite P3: the option cannot run as it stands (a profile with no
	 *  credential): its row is dim. It can still be picked; the caller says
	 *  why, as it always has. */
	readonly off?: boolean;
	/** Graphite P3: further texts the filter reaches (a profile's name),
	 *  after the label and the first column. Never drawn. */
	readonly match?: readonly string[];
	/** Graphite P3: what ⏎ does on THIS row, for the key row
	 *  (`⏎ opens /model`); absent, the spec's word. */
	readonly enter?: string;
}

/** The level cursor, CORRECTED at read time: never off the end, never on
 *  a forbidden index, and never invented where the caller supplied none.
 *
 *  One rule instead of two. The alternative \u2014 letting the cursor rest on
 *  a forbidden index and refusing at enter \u2014 needs a second mechanism to
 *  say why nothing happened, and a key that silently does nothing is the
 *  defect this panel already fixed once (DC-36). Correcting on read is
 *  the discipline the session picker uses for its own selection. */
export function enabledLevel(o: PickOption | undefined, want: number | null): number | null {
	const levels = o?.levels;
	if (levels === undefined || levels.length === 0 || want === null) return null;
	const off = new Set(o?.disabled ?? []);
	if (off.size >= levels.length) return null; // every level forbidden: nothing to point at
	const clamped = Math.max(0, Math.min(levels.length - 1, want));
	if (!off.has(clamped)) return clamped;
	// walk outward from the asked-for index, nearest first
	for (let d = 1; d < levels.length; d += 1) {
		const hi = clamped + d;
		if (hi < levels.length && !off.has(hi)) return hi;
		const lo = clamped - d;
		if (lo >= 0 && !off.has(lo)) return lo;
	}
	return null;
}

/** Where the cursor OPENS on an option: what the caller asked for,
 *  corrected. The two callers (the panel opening, and the highlight
 *  moving to another row) mean exactly this and nothing else. */
export function startLevel(o: PickOption | undefined): number | null {
	return enabledLevel(o, o?.level ?? null);
}

/** The next enabled index in `dir`, or the current one at the end of the
 *  ladder. Forbidden indexes are stepped OVER, never landed on. */
export function stepLevel(o: PickOption, from: number | null, dir: -1 | 1): number | null {
	const levels = o.levels;
	if (levels === undefined || levels.length === 0) return null;
	// the first press on a row that marks nothing enters the ladder at
	// its near end rather than guessing a middle.
	if (from === null) return enabledLevel(o, dir === 1 ? 0 : levels.length - 1);
	const off = new Set(o.disabled ?? []);
	for (let i = from + dir; i >= 0 && i < levels.length; i += dir) {
		if (!off.has(i)) return i;
	}
	return from;
}

/** The whole pick: the band's name, the options, how the keys reach
 *  them, and the honest empty state. */
export interface PickSpec {
	/** the band's NAME (`model`). A legacy `name — words` header still
	 *  splits: the words join the facts. */
	readonly header: string;
	readonly options: readonly PickOption[];
	/** Graphite P3: what the band's name says after the count
	 *  (`current: default · don't ask`, `run paused`). */
	readonly facts?: string;
	/** Graphite P3: the band counts its options with this noun
	 *  (`profiles` → `9 profiles`, `""` → `11`), and says `2 of 9 match`
	 *  under a filter. Absent, no count. */
	readonly noun?: string;
	/** Graphite P3: how keys reach the rows. `digits` (the default): a digit
	 *  moves to that row on screen. `filter`: the input row filters, as in
	 *  /resume — a digit is a letter there. `arrows`: ↑↓ alone. */
	readonly input?: "digits" | "filter" | "arrows";
	/** filter only: the input row's words while it is empty */
	readonly filterHint?: string;
	/** filter only: a typed `provider/model` that nothing on the list
	 *  matches becomes a row of its own, and ⏎ on it hands the text back. It
	 *  replaced the `t` row (P3, owner, 2026-10-04). Only when NOTHING
	 *  matches: a slash typed into a profile's name (`op/`) is filtering. */
	readonly direct?: boolean;
	/** how the columns are styled, by index: `dim` unless `plain` */
	readonly columns?: readonly ("plain" | "dim")[];
	/** the column that shows the walked level on the selected row (a
	 *  setting's value follows ←→) */
	readonly levelColumn?: number;
	/** what ⏎ does, for the key row (`⏎ switches`); a row may say its own */
	readonly enter?: string;
	/** shown INSTEAD of the options when there are none. The copy is the
	 *  caller's and is reproduced verbatim. */
	readonly emptyNote?: string;
	/** MP-1 (0.40.7): the row the cursor OPENS on — the session's current
	 *  profile or tier. Absent (or out of range) opens on the first row.
	 *  Opening on row 0 is how one Enter used to switch the account that
	 *  pays without anyone choosing to. */
	readonly initial?: number;
}

/** The pick panel's runtime state — the editor owns it, the compositor
 *  reads it (the AskRuntime precedent). */
export interface PickRuntime {
	/** an OPTION index (never a position on screen); `options.length` is
	 *  the direct row. Corrected at read time by `pickList`. */
	readonly cursor: number;
	/** OR-7: the level cursor within the highlighted option. null = the
	 *  option has no levels, or has no default to mark. */
	readonly level: number | null;
	/** filter: the input's text, read from the composer on every frame —
	 *  the panel never stores a copy that could disagree with it */
	readonly query?: string;
}

/** Graphite P3 — what the pick shows right now, derived from the spec and
 *  the runtime: the ONE derivation the renderer, the keys and the digit
 *  window all read, so the row the eye is on is the row a key acts on. */
export interface PickList {
	/** the option indexes on the list, in the caller's order; the direct
	 *  row (`options.length`) last when it is offered */
	readonly shown: readonly number[];
	/** the cursor, corrected: an entry of `shown`, or -1 when nothing shows */
	readonly cursor: number;
	/** the level in force for the cursor's option */
	readonly level: number | null;
	/** the typed letters, per option: which text they landed in (0 the
	 *  label, 1 the first column) and where */
	readonly hits: ReadonlyMap<number, { readonly col: number; readonly at: readonly number[] }>;
	/** what the direct row would hand back, when it is offered */
	readonly direct: string | null;
	/** the query the list was filtered by ("" when none) */
	readonly query: string;
}

export function pickList(spec: PickSpec, state: PickRuntime): PickList {
	const query = spec.input === "filter" ? (state.query ?? "") : "";
	const lq = query.toLowerCase();
	const shown: number[] = [];
	const hits = new Map<number, { col: number; at: readonly number[] }>();
	spec.options.forEach((o, i) => {
		if (lq === "") {
			shown.push(i);
			return;
		}
		// the label, then the first column (a profile's host), then the
		// texts the row does not draw (its name) — the first that holds
		// the query is where the gold goes
		const drawn = [o.label, ...(o.cols ?? []).slice(0, 1)];
		for (let c = 0; c < drawn.length; c += 1) {
			const at = atEmbed(drawn[c]!.toLowerCase(), lq);
			if (at !== null) {
				shown.push(i);
				hits.set(i, { col: c, at });
				return;
			}
		}
		if ((o.match ?? []).some((m) => atEmbed(m.toLowerCase(), lq) !== null)) shown.push(i);
	});
	const typed = query.trim();
	const direct = spec.direct === true && shown.length === 0 && /^[^/\s]+\/\S+$/.test(typed) ? typed : null;
	if (direct !== null) shown.push(spec.options.length);
	// a cursor the filter took away lands on the first row left, and the
	// level comes with the row it lands on
	const cursor = shown.includes(state.cursor) ? state.cursor : (shown[0] ?? -1);
	const level = cursor === state.cursor ? state.level : startLevel(spec.options[cursor]);
	return { shown, cursor, level, hits, direct, query };
}

/** What was picked: a listed option by INDEX (never a label the caller
 *  would have to re-match against its own list), or typed text. */
export type PickResult = { readonly index: number } | { readonly custom: string };

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
	 *  ("❯ run paused", the trust gate's line). */
	readonly statusText: string;
	/** The ALWAYS-verbose args — the full command/content/diff. */
	readonly args: PanelArgs;
	/** The simple flavor's full rule line (the trust/uncertain
	 *  questions) — overrides the why-asked composition. */
	readonly ruleOverride?: string;
	/** The fallback question — the y/n text for the dock-less path
	 *  (a TTY without a dock, or a pipe). */
	readonly fallbackQuestion: string;
	/** TUI2-R3v2 ③: this call is the model's answer to a refusal — the v4
	 *  frame's "(amended)" marker. It says WHY the call looks different
	 *  from the one just refused; without it a second approval for the same
	 *  tool reads as the product asking twice. */
	readonly amended?: boolean;
	/** TUI2-R3v2 ④: the deletion-risk line, when the command matches one
	 *  of the four irreversible patterns. Composed by the CLI (which owns
	 *  the tool input) from deletionRiskHint; absent for every other
	 *  command, which is most of them. */
	readonly riskHint?: string;
	/** TUI2-R3v2 ①: the SIMPLE flavor's two labels. A trust gate answers
	 *  "Yes / No", but an uncertain execution answers "rerun / abandon"
	 *  and an unanswered ask "re-ask / drop" — those callers used to
	 *  smuggle their labels into the rule line as "— 1 rerun · 3 abandon",
	 *  which stated the digits as well, and the digits have moved. The
	 *  labels belong on the rows that carry them. */
	readonly simpleOptions?: readonly [string, string];
	/** KC3.5: the questions, when this view is an ASK. Present = the
	 *  panel renders the ask block and the editor routes the ask keys;
	 *  absent = the approval/simple panel, unchanged. */
	readonly ask?: AskSpec;
	/** TUI2-R2 \u2463: the options, when this view is a PICK. Same contract
	 *  as `ask`, one payload over. */
	readonly pick?: PickSpec;
	/** Graphite P1b (owner, 2026-09-30) — kiso's OWN question (a cold
	 *  cache, a call that may have run, an unanswered question, the trust
	 *  gate). Present = the panel opens on the question as its band name
	 *  with the facts dim after it, then at most two sentences at the
	 *  content edge; the gutter keeps only what is quoted verbatim (`args`).
	 *  Absent = the approval layout, unchanged. */
	readonly asked?: { readonly question: string; readonly facts: readonly string[]; readonly prose: string };
}

export type PanelVerdict =
	| { readonly action: "allow"; readonly reason: string }
	| { readonly action: "allow-rule"; readonly rule: string }
	| { readonly action: "deny"; readonly reason: string }
	| { readonly action: "cancel" }
	/** KC3.5: the ask's own verdict — the answers (or the decline) the
	 *  cli hands back to the tool. Only ask views ever produce it, so
	 *  the approval path's switch is untouched. */
	| { readonly action: "answers"; readonly result: AskResult }
	/** TUI2-R2 \u2463: the pick's verdict \u2014 the chosen index or the typed
	 *  text. Only pick views ever produce it, so the approval path's
	 *  switch is untouched. OR-7 adds the second axis beside it: the
	 *  level INDEX, absent when the option had no levels or marked none. */
	| { readonly action: "picked"; readonly result: PickResult; readonly level?: number };

/** The bound panel state the compositor reads — the editor owns the
 *  phase/selection state machine and the key routing; the compositor
 *  renders it (the block rows, the input lead, the status/hint). */
export interface PanelState {
	readonly view: PanelView;
	readonly phase: PanelPhase;
	/** TUI2-R3v2 ①: the highlighted row, 0-based into panelOptions(view).
	 *  There is no "nothing selected" value any more — the bar opens on
	 *  the first option, which is what makes a bare ⏎ an approval. */
	readonly cursor: number;
	/** TUI2-R3v2 ①: the one dim line a failed gesture owes the human (the
	 *  safer-options degradation). Absent when there is nothing to say. */
	readonly note?: string;
	/** TUI2-R3v2 ③: the safer list's walk — present exactly in the
	 *  "safer" phase. */
	readonly safer?: SaferRuntime;
	/** KC3.5: the ask's walk — present exactly when `view.ask` is. */
	readonly ask?: AskRuntime;
	/** TUI2-R2 \u2463: the pick's walk — present exactly when `view.pick` is. */
	readonly pick?: PickRuntime;
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
	// TUI2-R2pre ④: the rule line is the panel's header — it says the ACT
	// ("edit needs approval"). view.name keeps the RAW tool name, which is
	// what the option-2 rule prefill and the fallbackQuestion (the
	// dock-less/pipe path — byte-identical by ruling) still read.
	// TUI2-R3v2 ③: the marker is SPLICED, and the un-amended line's bytes
	// are left exactly as they were.
	//
	// The first version composed one template for both cases, closing and
	// reopening the dim run around the marker slot. That is invisible on
	// screen and it broke the RAW BYTE run "needs approval — asked by",
	// which four PTY gates use as a frame needle — the driver matches on
	// the byte stream, so the needle stopped matching, the approval was
	// never answered, and the panel hung. An ordinary approval must be
	// byte-identical to what it was; only the amended one differs.
	const head = `${p.bold}${escapeTerminal(displayVerb(view.name))}${p.reset} `;
	const tail = ` ${p.bold}${escapeTerminal(view.speaker)}${p.reset}`;
	const base =
		view.amended === true
			? `${head}${p.dim}needs approval · (amended) — asked by${p.reset}${tail}`
			: `${head}${p.dim}needs approval — asked by${p.reset}${tail}`;
	// DC-3: the fix hint is metadata — it borrowed the inline-code tint.
	return hint ? `${base}${p.dim} · ${escapeTerminal(hint)}${p.reset}` : base;
}

/**
 * TUI2-R3v2 ① — ONE ROW PER OPTION, and the cursor's row is a bar.
 *
 * The retired form packed every option onto one line and, below W=47,
 * DROPPED the middle one to make the line fit — a narrow terminal
 * silently lost the ability to grant a durable rule. A list has no such
 * trade to make: each option owns a row, a narrow window cuts LABELS,
 * and every choice stays reachable at every width the product survives.
 *
 * The unselected row is a two-space indent; the selected row is the
 * shared selectionBar, which spends its own two cells of frame. Both
 * build their span against W−2, so the digit column does not shift as
 * the bar walks — a column that moves per row reads as damage, which is
 * the R2 picker's finding, inherited.
 *
 * R2 — two changes. The unselected row carried the block's │ gutter: a
 * gutter SCOPES a verbatim block (the args keep theirs), and an option
 * list is not verbatim, so it draws a boundary the block already has a
 * rule for. And the cursor now carries `→` as well as the bar (design
 * §7.5) — the bar is the loud signal, the arrow is the one that
 * survives a strip, which is law 1.3's test applied to a selection.
 */
function panelOptionRow(option: PanelOption, n: number, selected: boolean, W: number, note?: string, stop = 0): string {
	const p = palette();
	const room = Math.max(1, W - 2);
	const plain = optionLead(option, n, selected);
	const tail =
		note === undefined || note === ""
			? ""
			: stop > 0
				? `${" ".repeat(Math.max(1, stop - visibleWidth(plain)))}${p.dim}${widthCut(escapeTerminal(note), Math.max(0, room - stop))}${p.reset}`
				: `${p.dim}  — ${escapeTerminal(note)}${p.reset}`;
	const text = cutLine(`${selected ? p.bold : ""}${escapeTerminal(plain)}${p.reset}${tail}`, room);
	if (!selected) return ` ${text}`;
	return selectionBar(text, visibleWidth(text), W);
}

/** The row's left span, PLAIN — written once so the column arithmetic
 *  and the row cannot disagree about how wide it is. */
function optionLead(option: PanelOption, n: number, selected: boolean): string {
	return `${selected ? "→" : " "} ${n} ${option.label}`;
}

/** R2 — the safer list's `why` column. Same rule as the ask panel's
 *  descriptions: computed over the WHOLE list so the column belongs to
 *  the list, and 0 (the em-dash fallback) when there is no room for it. */
function saferStop(options: readonly { readonly command: string }[], W: number): number {
	// an empty list has no column to compute — `Math.max()` of nothing is
	// -Infinity, which would sail through both guards below and return a
	// negative stop
	if (options.length === 0) return 0;
	const room = Math.max(1, W - 2);
	const widest = Math.max(...options.map((o, i) => visibleWidth(optionLead({ kind: "allow", label: o.command }, i + 1, false))));
	const stop = widest + 2;
	return stop > Math.floor(room / 2) || room - stop < 18 ? 0 : stop;
}

/**
 * TUI2-R3v2 ② — the block's rows AND where its option rows landed.
 *
 * The click hit-test needs to answer "which option is at screen row N",
 * and the only honest source for that is the arithmetic that placed the
 * rows. Computing it a second time — in the compositor, or in a helper
 * that mirrors the budget — is how a hit-test comes to disagree with the
 * picture: the args cap, the note row and the option window all move the
 * list, and a mirror that misses one sends the click to the wrong
 * verdict. So the renderer reports it, and there is exactly one copy of
 * the sum.
 *
 * `offset` is the index of the first option row INSIDE the returned
 * rows; `first` is which option that row shows (the window's start, non-
 * zero only on a short block).
 */
export interface PanelBlockLayout {
	readonly rows: readonly string[];
	readonly offset: number;
	readonly count: number;
	readonly first: number;
}

/** The block's rows — EXACTLY the preview's frame shape, the gutter at
 *  the left edge (the preview's two-space mock indent is its own
 *  styling; the real rows sit at column 1, like every tool cell).
 *  maxRows caps the TOTAL (the args fold; the single-row lines cut). */
export function panelBlockRows(view: PanelView, phase: PanelPhase, cursor: number, W: number, maxRows: number, note?: string, safer?: SaferRuntime): string[] {
	return panelBlockLayout(view, phase, cursor, W, maxRows, note, safer).rows as string[];
}

export function panelBlockLayout(view: PanelView, phase: PanelPhase, cursor: number, W: number, maxRows: number, note?: string, safer?: SaferRuntime): PanelBlockLayout {
	const p = palette();
	// R2: the block's own PROSE rows (the risk line, the safer-options
	// note, the affordance) take the two-space indent every other row in
	// the block takes. The │ gutter stays where it means something — on
	// the args, which are verbatim, and which is the whole distinction:
	// a gutter SCOPES a quotation, it is not a left edge for a panel.
	const gutter = "  ";
	const rows: string[] = [];
	// R2 — the block opens and closes with the SAME dashed rule the
	// composer uses. It used to open with the │ gutter, divide with a
	// ─ run and close with a └ rule: three edge vocabularies inside one
	// block, and none of them the composer's. A rule SEPARATES, a gutter
	// SCOPES — the args keep their gutter because they are a verbatim
	// block; everything that was drawing a boundary is one rule now.
	// Graphite P1b: kiso's own question names the band itself — the
	// question, its facts dim — and says its sentence once, at the content
	// edge. The approval's three rows (the rule, the title, the divider)
	// would say it three times: the rule line WAS the question, the title
	// its facts, and the args its sentence again in a gutter that means
	// "quoted verbatim".
	const asked = view.asked;
	const prose = asked === undefined ? [] : foldWords(escapeTerminal(asked.prose), Math.max(1, W - 4)).map((r) => `${gutter}${r}`);
	// Graphite P4 (owner, 2026-10-04): an approval says the call ONCE, as its
	// card will read in the transcript (`SHELL rm -rf build`), and the band's
	// name carries who asked. DECLARED REVERSAL of the `<tool> needs approval
	// — asked by <speaker>` row, of the bold title under it and of the blank
	// row after them (R3a, TUI2-R1.5 ⑤). The body follows only when it adds
	// something: a diff, JSON, or a command the head row cannot show whole.
	const verb = escapeTerminal(displayVerb(view.name)).toUpperCase();
	const verbHead = `${p.bold}${verb}${p.reset}${view.title === "" ? "" : ` ${escapeTerminal(view.title)}`}`;
	const sayOnce = view.flavor === "approval" && asked === undefined;
	// a call that is ONE line of text (a shell command) and is its own title:
	// said once even when the row cannot hold it — the head row folds, its
	// continuation rows under the command's first cell, breaking at a space
	// where it can (the owner's capture, 2026-10-05: cut in the head and then
	// repeated whole in a body, the first half read twice, `sessi|ons` split)
	const oneLine = sayOnce && view.args.kind === "text" && view.args.lines.length === 1 && view.args.lines[0] === view.title;
	const headRoom = Math.max(1, W - 2);
	// (one cell of margin at the right, as the other rows keep)
	const folds = oneLine && visibleWidth(verbHead) > headRoom && headRoom - verb.length - 2 >= 12 ? foldAtSpaces(escapeTerminal(view.title), headRoom - verb.length - 2) : null;
	if (asked !== undefined) {
		rows.push(bandHeader(askedLabel(asked.question, asked.facts, W), W));
		rows.push(...prose);
	} else if (sayOnce) {
		const facts = [...(view.amended === true ? ["amended"] : []), `asked by ${escapeTerminal(view.speaker)}`];
		rows.push(bandHeader(`needs you \u00b7 ${facts.join(" \u00b7 ")}`, W));
		rows.push(folds === null ? `  ${cutLine(verbHead, headRoom)}` : `  ${p.bold}${verb}${p.reset} ${folds[0]}`);
	} else {
		// a question with no layout of its own (no caller in the product
		// draws one since P1b): the old head, kept for that case
		rows.push(bandHeader("needs you", W));
		rows.push(`  ${cutLine(panelRuleText(view), Math.max(1, W - 2))}`);
		rows.push(`  ${cutLine(`${p.bold}${escapeTerminal(view.title)}${p.reset}`, Math.max(1, W - 2))}`);
		rows.push("");
	}
	// the args — the bounded block's body: fold, then cap. The └ cut is
	// ONE row (the W20 discipline): when the args exceed the budget, one
	// notice row carries the count and where the rest is (the event log).
	const repeats = oneLine && (visibleWidth(verbHead) <= headRoom || folds !== null);
	// the folded command's continuation rows ride the args' budget, so a
	// command taller than the screen still ends in the honest cut notice
	const args: string[] = repeats
		? (folds ?? []).slice(1).map((r) => `  ${" ".repeat(verb.length + 1)}${r}`)
		: view.args.kind === "diff"
			? diffBody(view.args.diff, W, true) // the expanded path — never the tool cell's capped copy
			: view.args.lines.flatMap((line) => gutterFold(`${p.dim}│${p.reset} `, escapeTerminal(line), W));
	// the speaker's fix hint (`/mode accept-edits approves edits`) rode the
	// end of the retired rule row and was cut there; it has a row of its own
	const hintRow = sayOnce && view.hint !== undefined && view.hint !== "" ? [`${gutter}${cutLine(`${p.dim}${escapeTerminal(view.hint)}${p.reset}`, Math.max(1, W - 2))}`] : [];
	// the amend phase says where the note goes, where the person is looking —
	// it was the status row's, and the bar stays under the panel now
	const amendRow = phase === "amend" ? [`${gutter}${cutLine(`${p.dim}your note goes to the model \u2014 it will propose a new call${p.reset}`, Math.max(1, W - 2))}`] : [];
	// TUI2-R3v2 ①: the block spends N rows on options instead of one, so
	// the args and the list SHARE what is left after the chrome. The list
	// wins the tie: a human at an approval is choosing, and one more line
	// of a command they can also read in the event log is worth less than
	// the row that carries the choice. The args keep a floor of one row so
	// the block never claims to show what it is asking about and then
	// shows nothing.
	const chrome =
		// P4: the band row, the call's head and the key row (no blank, no
		// rule under it); kiso's own question: the band row, its sentences,
		// the key row; the old head: four rows and the key row
		(asked === undefined ? (sayOnce ? 3 : 5) : 2 + prose.length) +
		hintRow.length +
		amendRow.length +
		(phase === "options" && note !== undefined ? 1 : 0) +
		(view.riskHint !== undefined && view.riskHint !== "" ? 1 : 0) +
		(phase === "asking" ? 1 : 0) +
		// the safer list's rows + its way-back row + the row that says so
		(phase === "safer" && safer !== undefined ? safer.options.length + 2 : 0);
	const optionCount = phase === "options" ? panelOptions(view).length : 0;
	const optionsShown = Math.min(optionCount, Math.max(1, maxRows - chrome - 1));
	const argsBudget = Math.max(1, maxRows - chrome - optionsShown);
	let shown: string[];
	if (args.length > argsBudget) {
		const kept = Math.max(0, argsBudget - 1);
		const n = args.length - kept;
		shown = [...args.slice(0, kept), cutLine(`${p.dim}└ +${n} more rows — the full args are in the event log${p.reset}`, Math.max(1, W - 2))];
	} else {
		shown = args;
	}
	rows.push(...shown);
	// TUI2-R3v2 ④: the risk hint sits directly under the args, because it
	// is a sentence ABOUT those args — the v4 frame's placement. The warn
	// tint is the palette's existing functional yellow (no new colour).
	//
	// DC-42: it used to open with a warning mark, on the argument that
	// the mark carried the warning once NO_COLOR took the tint away. It does not
	// carry anything the sentence does not — "deletes files permanently"
	// IS the warning, and §1.3 gives a symbol its cell only for a fact
	// the words lack. What separates kiso's sentence from the command's
	// own lines survives the strip either way: the args wear the `│`
	// gutter and this row wears the plain two-space indent.
	const risk = view.riskHint;
	if (risk !== undefined && risk !== "") rows.push(`${gutter}${cutLine(`${p.warn}${escapeTerminal(risk)}${p.reset}`, Math.max(1, W - 2))}`);
	rows.push(...hintRow, ...amendRow);
	// TUI2-R3v2 ①: the option LIST. While the typed phase is open the list
	// stands down — the human is writing prose to the model, and a bar
	// hovering over "Yes, run it" while they do it claims a choice is still
	// live that their next keystroke is not addressing.
	let offset = 0;
	let first = 0;
	// TUI2-R3v2 ③: the in-flight line. A button that goes quiet for two
	// seconds reads as broken, and this one is making a network call —
	// so the panel says what it is doing, and says that esc still works.
	if (phase === "asking") {
		rows.push(`${gutter}${cutLine(`${p.dim}asking the model for safer options…${p.reset}`, Math.max(1, W - 2))}`);
	}
	// TUI2-R3v2 ③: the alternatives, as a list in the SAME shape as the
	// approval's own — the round's one interaction model, applied to the
	// one new surface rather than excepted from it. The way back is the
	// last row and is always present: an alternatives list you cannot back
	// out of would be a trap.
	if (phase === "safer" && safer !== undefined) {
		// Graphite P4: what happened, said in the block — it was the status
		// row's, and the bar stays under the panel now
		rows.push(`${gutter}${cutLine(`${p.dim}asked the model for safer options${p.reset}`, Math.max(1, W - 2))}`);
		offset = rows.length;
		// R2: the `why` takes a COLUMN rather than running on after an em
		// dash — the commands are what is being chosen between, and they
		// only scan when they all start and end at the same columns.
		const stop = saferStop(safer.options, W);
		for (let i = 0; i < safer.options.length; i += 1) {
			const o = safer.options[i]!;
			rows.push(panelOptionRow({ kind: "allow", label: o.command }, i + 1, i === safer.cursor, W, o.why, stop));
		}
		rows.push(panelOptionRow({ kind: "deny", label: SAFER_BACK }, safer.options.length + 1, safer.cursor === safer.options.length, W));
	}
	if (phase === "options") {
		if (note !== undefined) rows.push(`${gutter}${cutLine(`${p.dim}${escapeTerminal(note)}${p.reset}`, Math.max(1, W - 2))}`);
		offset = rows.length;
		const options = panelOptions(view);
		// A window, never a truncation. On a screen too short for the whole
		// list the options SCROLL under the bar — the cursor's row is always
		// in view, ↑↓ still reach every option and the digits still address
		// the full list (the affordance says "1-4" whether four rows fit or
		// two do). Dropping the tail instead would make an option that the
		// key still takes invisible, which is the one failure a permission
		// list must not have.
		first = Math.max(0, Math.min(cursor - optionsShown + 1, options.length - optionsShown));
		for (let i = first; i < first + optionsShown; i += 1) rows.push(panelOptionRow(options[i]!, i + 1, i === cursor, W));
	}
	const layout = {
		offset,
		// the safer list is clickable by the same rule the option list is —
		// one interaction model means the click works on every list, and its
		// rows include the way back (hence +1)
		count: phase === "options" ? optionsShown : phase === "safer" && safer !== undefined ? safer.options.length + 1 : 0,
		first,
	};
	// Graphite P4 (owner, 2026-10-04): one key row closes the band, with the
	// selection's place at the right margin on a list (§8.2); the composer's
	// rail sits under it. DECLARED REVERSAL of the panel's own bottom rule
	// (TUI2-R1.5 ⑪, R2), which doubled the composer's.
	const list = phase === "options" ? { at: cursor, of: panelOptions(view).length } : phase === "safer" && safer !== undefined ? { at: safer.cursor, of: safer.options.length + 1 } : null;
	rows.push(panelKeyRow(panelAffordance(view, phase, cursor, safer), list, W));
	return { rows, ...layout };
}

/** Graphite P4's fold for a one-line command; it lives with the card's
 *  head now, which folds a command the same way (the card round). */
export { foldAtSpaces };

/** The key row: the keys, cut by cells, and the counter at the right margin. */
export function panelKeyRow(keys: string, list: { readonly at: number; readonly of: number } | null, W: number): string {
	const p = palette();
	const count = list === null ? "" : `${list.at + 1}/${list.of}`;
	const room = Math.max(1, W - 1 - 2 - (count === "" ? 0 : count.length + 2));
	const text = cutLine(keys, room);
	const gap = count === "" ? "" : " ".repeat(Math.max(2, W - 1 - 2 - visibleWidth(text) - count.length));
	return `  ${p.dim}${text}${gap}${count}${p.reset}`;
}

/** Graphite P4: kiso's own question names the band with its facts; when the
 *  label does not fit, the LAST fact (a path) is cut from the left, so its
 *  end — the folder's own name — and the rule after it stay on screen. */
function askedLabel(question: string, facts: readonly string[], W: number): string {
	const room = Math.max(1, W - 8); // `─── ` before the label, ` ───` after it
	const whole = [question, ...facts].join(" \u00b7 ");
	if (visibleWidth(whole) <= room || facts.length === 0) return whole;
	const head = [question, ...facts.slice(0, -1)].join(" \u00b7 ");
	const left = room - visibleWidth(head) - 3 - 1; // ` · ` and the ellipsis
	if (left < 4) return whole; // too narrow to say anything useful of it — the band cuts as it always did
	let tail = "";
	for (const ch of [...facts[facts.length - 1]!].reverse()) {
		if (visibleWidth(ch + tail) > left) break;
		tail = ch + tail;
	}
	return `${head} \u00b7 \u2026${tail}`;
}

/**
 * The input row's lead. In the options phase there is NOTHING to type,
 * so the lead stops pretending there is.
 *
 * "1-3> " was a prompt: it told the human to enter something and press
 * return, which is exactly the interaction this round removed. The row
 * keeps the composer's own quiet lead while the list is up (the keys are
 * on the list and in the hint line), and the typed phase — the one place
 * a human really is writing — leads with the word for what they are
 * writing.
 */
export function panelLead(_view: PanelView, _phase: PanelPhase, _cursor: number): string {
	// Graphite P4 (owner, 2026-10-04): a panel leaves the input row to the
	// composer in every phase — DECLARED REVERSAL of the named `amend›` lead;
	// the empty note row carries a dim hint instead (the tui's panelHintOf)
	return PANEL_IDLE_LEAD;
}

/** The composer's lead while a selection list owns the keys.
 *
 *  R2: EMPTY. It was a quiet chevron, on the argument that it is "not a
 *  prompt for input that is not being asked for" — but the composer
 *  dropped its own chevron this round (the cursor sits at column one),
 *  so the panel would have been the one surface reintroducing the glyph
 *  the rest of the product just removed. The NAMED leads stay: `amend›`
 *  and the pick panel's `1-4>` say where the keystrokes go, which is
 *  information rather than decoration. */
const PANEL_IDLE_LEAD = "";

/** The lead's plain text — the editor's reflow width (the line must
 *  fit the lead + the drawn cursor's own cell — R2 retired the box and
 *  its walls with it). */
export function panelLeadPlain(_view: PanelView, _phase: PanelPhase, _cursor: number): string {
	return PANEL_IDLE_LEAD;
}

export function panelLeadWidth(view: PanelView, phase: PanelPhase, cursor: number): number {
	return displayWidth(panelLeadPlain(view, phase, cursor));
}

/** The status row's left text while the panel is up — the phase, not
 *  the CLI's painting status (the compositor derives it from the panel
 *  state; the "❯ run paused" etc. ride the options phase). */
// R2 (design §4, the ❯ ruling): a panel that is WAITING ON A HUMAN says
// so with the one mark that means it. `▸` already means "the current
// one" — a mark meaning two things is worse than two marks
// (law 4.2), and the thing this row has to convey is not "here" but
// "nothing moves until you answer".
export function panelStatus(view: PanelView, phase: PanelPhase, cursor: number): string {
	// TUI2-R3v2 ③: the frames' own words — what the panel is doing, and
	// (in the safer list) what it did.
	if (phase === "asking") return "\u23f8 asked the model for safer options";
	if (phase === "safer") return "\u23f8 asked the model for safer options";
	// TUI2-R3v2 ①: the typed phase says where the words GO. "the words ride
	// the verdict" described the plumbing to whoever wrote it; the human
	// typing needs to know the model will read this and answer with a new
	// call — which is what the v4 frame says, in those words.
	if (phase === "amend") return "❯ your note goes to the model — it will propose a new call";
	return view.statusText;
}

/**
 * The status row's right-aligned hint — the v4 frame's line, verbatim.
 *
 * It names all four gestures because all four now exist at once and the
 * digit range is the only part that varies: "1-4" on an approval, "1-2"
 * on the simple flavors. The click is advertised for the same reason the
 * arrows are — an affordance nobody is told about is one nobody uses.
 */
export function panelAffordance(view: PanelView, phase: PanelPhase, cursor: number, safer?: SaferRuntime): string {
	// Graphite P4: the amend keys say where esc goes back to
	if (phase === "amend") return "⏎ sends · esc back to the choices";
	// TUI2-R3v2 ③: the ask is in flight — the ONE key that still means
	// something is the one that gets you out of it.
	if (phase === "asking") return "esc cancels";
	// the same sentence the approval list carries, counting the rows THIS
	// list has (the alternatives plus the way back)
	if (phase === "safer" && safer !== undefined) {
		return `↑↓ move · ⏎ or click confirms · 1–${safer.options.length + 1} instant · esc`;
	}
	// Graphite P4 (owner, 2026-10-04): on an approval esc is a denial (the CLI
	// records it as one), so the key row says so; kiso's own questions keep
	// the bare `esc`, which declines them
	return `↑↓ move · ⏎ or click confirms · 1–${panelOptions(view).length} instant · ${view.flavor === "approval" ? "esc denies" : "esc"}`;
}


// ── TUI2-R2 ④, Graphite P3: the pick block, its lead, its status ────

/**
 * Graphite P3 (owner, 2026-10-04) — the pick block takes the shape of every
 * list band (§8.2, §8.13). The band names itself with its count or its
 * current value; a window of eight rows from a 30-row terminal, five below,
 * with dim more-marks in column 0; the rows a TABLE, each column measured
 * over the whole list; the selected row the card head every list shares,
 * OPENED into a second row on the same wash (the /resume shape) for the
 * level strip and what the columns cannot hold; one key row with the
 * counter. No closing rule: the composer's rail closes the band, as it does
 * the command list.
 *
 * DECLARED REVERSALS (P3, owner, 2026-10-04): the `current:` row (its words
 * ride the band's name), the bracketed level (the level in force is gold),
 * the `↕ 1-9 / 11` row (the more-marks say it), PICK_MAX's nine-row window
 * (§8.2's eight and five), and the `t` row with its typing phase (a typed
 * `provider/model` is a row of the filter — PickSpec.direct).
 *
 * Single-row discipline: every row CUTS, never folds — the block's height
 * is its row count (the W20 rule the #checked throw demands).
 */
export function pickBlockRows(view: PanelView, state: PickRuntime, W: number, maxRows: number, height = 24): string[] {
	const p = palette();
	const spec = view.pick!;
	const list = pickList(spec, state);
	const total = spec.options.length;
	// a legacy `name — words` header: the name opens the band, the words join its facts
	const name = spec.header.split(" — ")[0] ?? spec.header;
	const said = spec.header.slice(name.length).replace(/^ — /, "");
	const matched = list.shown.filter((i) => i < total).length;
	const count = spec.noun === undefined ? "" : list.query !== "" ? `${matched} of ${total} match` : spec.noun === "" ? `${total}` : `${total} ${spec.noun}`;
	const facts = [count, said, spec.facts ?? ""].filter((f) => f !== "").join(" · ");
	const rows: string[] = [bandHeader(escapeTerminal(facts === "" ? name : `${name} · ${facts}`), W)];
	const room = Math.max(1, W - 3); // the two-cell lead and one cell of margin
	// the honest empty state — the caller's own copy, verbatim; a typed
	// `provider/model` is still a row under it
	if (total === 0) rows.push(`  ${cutLine(`${p.dim}${escapeTerminal(spec.emptyNote ?? "no options")}${p.reset}`, room)}`);
	else if (list.shown.length === 0) rows.push(`  ${cutLine(`${p.dim}nothing matches "${escapeTerminal(list.query)}"${p.reset}`, room)}`);
	if (list.shown.length === 0) {
		rows.push(bandKeyRow(["esc"], 0, 0, W));
		return rows;
	}
	const win = pickWindowOf(view, state, maxRows, height);
	const colsOf = (o: PickOption): readonly string[] => (o.cols ?? (o.note === undefined ? [] : [o.note])).map(escapeTerminal);
	// the columns measure over EVERY option, so a filter or a walked level
	// never moves them
	const labelW = Math.max(0, ...spec.options.map((o) => visibleWidth(escapeTerminal(o.label))));
	const colW: number[] = [];
	for (const o of spec.options) {
		colsOf(o).forEach((c, j) => {
			const levels = j === spec.levelColumn ? (o.levels ?? []).map((l) => visibleWidth(escapeTerminal(l))) : [];
			colW[j] = Math.max(colW[j] ?? 0, visibleWidth(c), ...levels);
		});
	}
	const lead = (mark: string | null): string => (mark === null ? " " : `${p.dim}${mark}${p.reset}`);
	for (let k = win.first; k < win.first + win.size; k += 1) {
		const i = list.shown[k]!;
		const on = i === list.cursor;
		const mark = moreMark(k, win.first, win.size, list.shown.length);
		if (i === total) {
			// the direct row: what was typed, offered as a pick of its own
			const text = cutLine(`use ${escapeTerminal(list.direct ?? "")} directly`, room);
			rows.push(on ? selectionBar(`${p.bold}→${text}${p.reset}`, visibleWidth(text) + 1, W) : `${lead(mark)} ${p.dim}${text}${p.reset}`);
			continue;
		}
		const o = spec.options[i]!;
		const hit = list.hits.get(i);
		const label = escapeTerminal(o.label);
		let text = `${goldHits(label, new Set(hit?.col === 0 ? hit.at : []), on ? p.bold : o.off === true ? p.dim : "")}${" ".repeat(Math.max(0, labelW - visibleWidth(label)))}`;
		let width = labelW;
		const cols = colsOf(o);
		cols.forEach((c, j) => {
			// a setting's value follows ←→ on the selected row
			const shown = on && j === spec.levelColumn && o.levels !== undefined && list.level !== null ? escapeTerminal(o.levels[list.level] ?? c) : c;
			const plain = spec.columns?.[j] === "plain";
			const style = plain ? (on ? p.bold : o.off === true ? p.dim : "") : p.dim;
			const last = j === cols.length - 1;
			text += `  ${goldHits(shown, new Set(hit?.col === j + 1 ? hit.at : []), style)}${last ? "" : " ".repeat(Math.max(0, (colW[j] ?? 0) - visibleWidth(shown)))}`;
			width += 2 + (last ? visibleWidth(shown) : (colW[j] ?? 0));
		});
		const cut = width > room ? cutLine(text, room) : text;
		if (!on) {
			rows.push(`${lead(mark)} ${cut}`);
			continue;
		}
		rows.push(selectionBar(`${p.bold}→${cut}`, Math.min(width, room) + 1, W));
		const open = openedRow(o, list.level, room);
		if (open !== null) rows.push(selectionBar(` ${open.text}`, open.width + 1, W));
	}
	const here = list.cursor >= 0 && list.cursor < total ? spec.options[list.cursor] : undefined;
	const keys = ["↑↓ move"];
	if (here?.levels !== undefined && here.levels.length > 0) keys.push(`←→ ${here.axisLabel ?? "effort"}`);
	if ((spec.input ?? "digits") === "digits" && win.size > 1) keys.push(`1–${Math.min(win.size, PICK_MAX)} picks`);
	keys.push(here?.enter ?? spec.enter ?? "⏎ confirms", "esc");
	rows.push(bandKeyRow(keys, Math.max(0, list.shown.indexOf(list.cursor)), list.shown.length, W));
	return rows;
}

/** Text cut to `room` cells by cells, with an ellipsis — plain text only. */
const fitCells = (t: string, room: number): string => (visibleWidth(t) <= room ? t : room <= 1 ? "" : `${widthCut(t, room - 1)}…`);

/** The selected row's second row: the level strip (the level in force
 *  bold gold, a level the thinking mode forbids dim), then what the caller
 *  has to say — the strip stays whole and the words give way. Null when
 *  there is nothing to open into. */
function openedRow(o: PickOption, level: number | null, room: number): { text: string; width: number } | null {
	const p = palette();
	// off a known ground the warn tint carries the gold, as the typed letters do
	const gold = p.gold !== "" ? p.gold : p.warn;
	const tail = o.levelNote ?? o.opened ?? "";
	if (o.levels === undefined || o.levels.length === 0) {
		if (tail === "") return null;
		const t = fitCells(escapeTerminal(tail), room);
		return { text: `${p.dim}${t}${p.reset}`, width: visibleWidth(t) };
	}
	const off = new Set(o.disabled ?? []);
	// a named axis is the row's own value (a setting), so its strip needs no
	// label; the model's effort is not the row's label, so it says `effort`
	const label = o.axisLabel === undefined ? "effort " : "";
	const levels = o.levels.map((l) => escapeTerminal(l));
	const cells = levels.map((t, i) => (i === level ? `${p.bold}${gold}${t}${p.reset}` : off.has(i) ? `${p.dim}${t}${p.reset}` : t));
	let text = `${label === "" ? "" : `${p.dim}${label}${p.reset}`}${cells.join(`${p.dim} · ${p.reset}`)}`;
	let width = visibleWidth(`${label}${levels.join(" · ")}`);
	const t = tail === "" ? "" : fitCells(escapeTerminal(tail), room - width - 5);
	if (t !== "") {
		text += `${p.dim}  ·  ${t}${p.reset}`;
		width += 5 + visibleWidth(t);
	}
	return width > room ? { text: cutLine(text, room), width: room } : { text, width };
}

/** The digits are the keys, so what one SCREEN offers is bounded by the
 *  digits there are. Finding DC-58 (the owner, 2026-09-21) made the window
 *  follow the cursor, so this is how many rows a digit can name, not how
 *  many rows the keyboard reaches. */
export const PICK_MAX = 9;

/**
 * The pick's window for THIS frame — the one derivation the renderer and
 * the digit keys share (DC-58's review: a size derived twice is a size that
 * can disagree). Positions are into `pickList(...).shown`.
 *
 * Graphite P3: §8.2's window (eight rows from a 30-row terminal, five
 * below, the cursor kept a row inside an edge while more lies past it),
 * within the frame's budget: the band's name, the key row, the opened row
 * and a `nothing matches` row are the chrome.
 */
export function pickWindowOf(view: PanelView, state: PickRuntime, maxRows: number, height = 24): { first: number; size: number } {
	const spec = view.pick;
	if (spec === undefined) return { first: 0, size: 0 };
	const list = pickList(spec, state);
	const here = list.cursor >= 0 && list.cursor < spec.options.length ? spec.options[list.cursor] : undefined;
	const opens = here !== undefined && ((here.levels?.length ?? 0) > 0 || (here.levelNote ?? here.opened ?? "") !== "") ? 1 : 0;
	const notice = spec.options.length === 0 || list.shown.length === 0 ? 1 : 0;
	const chrome = 2 + opens + notice;
	const size = Math.max(1, Math.min(bandVisible(height), maxRows - chrome));
	const { first, count } = bandWindow(list.shown.length, Math.max(0, list.shown.indexOf(list.cursor)), size);
	return { first, size: count };
}

/** The input row's lead. Graphite P3: a pick leaves the input row to the
 *  composer — the filter is typed there, and a digit list needs no lead
 *  to say so (its key row does). */
export function pickLeadPlain(_view: PanelView, _state: PickRuntime): string {
	return "";
}

export function pickLead(_view: PanelView, _state: PickRuntime): string {
	return "";
}

/** The status row's left text — the CALLER's, because only the caller
 *  knows whether a run is paused behind this panel. (Graphite P3: on a
 *  dock the bar stays under a pick; this is the dock-less text.) */
export function pickStatus(view: PanelView): string {
	return view.statusText;
}

/** The key words, for a caller that draws them outside the block. The
 *  block's own key row is the one on screen (P3). */
export function pickAffordance(_state: PickRuntime, axis: boolean | string = false): string {
	// DC-36 — the row NAMES the arrows; OR-7 names ←→ for the same reason,
	// and only when there is a second axis to walk
	return axis !== false ? `↑↓ move · ←→ ${axis === true ? "effort" : axis} · ⏎ confirms · esc` : "↑↓ move · ⏎ confirms · esc";
}

/** Compose a pick view. The flavor/name/title/args fields exist for the
 *  approval path and are given inert values here \u2014 the pick block
 *  reads none of them. */
/** DC-36 — the same shell for the MODE picker.
 *
 *  `/model` learned to pick in TUI2-R2 ④; `/mode` never did, and the
 *  five tiers are a CLOSED set — the one case where making a human
 *  type the answer is least defensible. The pick block reads only
 *  `pick` and `statusText`, so a second flavour is a name and a
 *  fallback question, not a second mechanism. */
export function modePickView(spec: PickSpec, statusText: string): PanelView {
	return {
		flavor: "simple",
		name: "mode",
		title: "mode",
		speaker: "you",
		statusText,
		args: { kind: "text", lines: [] },
		fallbackQuestion: "switch mode? (name) ",
		pick: spec,
	};
}

/** Graphite R3e — `/settings` as a pick panel: a row per setting, the
 *  session's own ones with a second axis to walk. */
export function settingsPickView(spec: PickSpec, statusText: string): PanelView {
	return {
		flavor: "simple",
		name: "settings",
		title: "settings",
		speaker: "you",
		statusText,
		args: { kind: "text", lines: [] },
		fallbackQuestion: "settings: (name) ",
		pick: spec,
	};
}

export function modelPickView(spec: PickSpec, statusText: string): PanelView {
	return {
		flavor: "simple",
		name: "model",
		title: "model",
		speaker: "you",
		statusText,
		args: { kind: "text", lines: [] },
		fallbackQuestion: "switch model? (name) ",
		pick: spec,
	};
}
