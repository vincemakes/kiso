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
import { cutLine, diffBody, gutterFold, selectionBar, visibleWidth, widthCut } from "./components.js";
// TUI2-R2pre ④: strings.js takes only a TYPE from this module, so the
// import is erased at compile time and no runtime cycle exists.
import { displayVerb } from "./strings.js";
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
		return targets.length === 0 ? "⚠ deletes files permanently" : `⚠ deletes files permanently (${targets.join(", ")})`;
	}
	if (verb !== "git") return null;
	const sub = words[1];
	// `git checkout -- <paths>` discards; `git checkout <branch>` does not,
	// and conflating them would put a red line on the most ordinary command
	// in the product.
	if (sub === "checkout" && words.includes("--")) return "⚠ discards your uncommitted changes — unrecoverable";
	if (sub === "reset" && words.includes("--hard")) return "⚠ throws away commits and working changes";
	// `git clean -n` is a DRY RUN and is the reason this checks for the f
	// rather than for the command.
	if (sub === "clean") {
		const letters = words
			.slice(2)
			.filter((w) => /^-[a-zA-Z]+$/.test(w))
			.join("");
		if (letters.includes("f")) return "⚠ deletes untracked files permanently";
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
}

/** The whole pick: the header sentence, the options, the free-text
 *  escape hatch, and the honest empty state. */
export interface PickSpec {
	readonly header: string;
	readonly options: readonly PickOption[];
	/** the `t` row — typing directly. OPTIONAL, and its absence means the
	 *  option list is the WHOLE world: `/model`'s profiles never are (a
	 *  model that exists but is not configured has to be typeable), and
	 *  `/mode`'s five tiers always are. Offering a `t` row over a closed
	 *  set is a row that carries no fact — §1.3 — and it is what made
	 *  the owner read the mode panel as "type the answer". */
	readonly typeHint?: string;
	/** shown INSTEAD of the options when there are none. The copy is the
	 *  caller's and is reproduced verbatim. */
	readonly emptyNote?: string;
}

/** The pick panel's runtime state \u2014 the editor owns it, the compositor
 *  reads it (the AskRuntime precedent, two fields instead of five). */
export interface PickRuntime {
	readonly cursor: number;
	readonly phase: "options" | "custom";
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
	 *  switch is untouched. */
	| { readonly action: "picked"; readonly result: PickResult };

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
	rows.push(`${p.dim}${"\u2500".repeat(Math.max(0, W))}${p.reset}`);
	rows.push(`  ${cutLine(panelRuleText(view), Math.max(1, W - 2))}`);
	rows.push(`  ${cutLine(`${p.bold}${escapeTerminal(view.title)}${p.reset}`, Math.max(1, W - 2))}`);
	// TUI2-R1.5 ⑤ (VD-11): the divider is a LABEL, not a design note. "the
	// full args — never truncated" is a sentence about the implementation,
	// addressed to whoever was building the panel; the human reading it
	// during an approval wants to know what the block below is.
	rows.push("");
	// the args — the bounded block's body: fold, then cap. The └ cut is
	// ONE row (the W20 discipline): when the args exceed the budget, one
	// notice row carries the count and where the rest is (the event log).
	const args: string[] =
		view.args.kind === "diff"
			? diffBody(view.args.diff, W, true) // the expanded path — never the tool cell's capped copy
			: view.args.lines.flatMap((line) => gutterFold(`${p.dim}│${p.reset} `, escapeTerminal(line), W));
	// TUI2-R3v2 ①: the block now spends N rows on options instead of one,
	// so the args and the list SHARE what is left after the chrome (the
	// rule, the title, the divider, the affordance, the corner — five
	// rows, plus the note when there is one). The list wins the tie: a
	// human at an approval is choosing, and one more line of a command
	// they can also read in the event log is worth less than the row that
	// carries the choice. The args keep a floor of one row so the block
	// never claims to show what it is asking about and then shows nothing.
	const chrome =
		// R2: SIX rows of frame, not five — the block opens with a rule now
		// as well as closing with one, and the divider row became a blank.
		// The count is the same shape it always was: every row the block
		// spends on itself before the args and the list share what is left.
		6 +
		(phase === "options" && note !== undefined ? 1 : 0) +
		(view.riskHint !== undefined && view.riskHint !== "" ? 1 : 0) +
		(phase === "asking" ? 1 : 0) +
		// the safer list's rows + its way-back row
		(phase === "safer" && safer !== undefined ? safer.options.length + 1 : 0);
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
	// tint is the palette's existing functional yellow (no new colour),
	// and under NO_COLOR the ⚠ still carries it.
	const risk = view.riskHint;
	if (risk !== undefined && risk !== "") rows.push(`${gutter}${cutLine(`${p.warn}${escapeTerminal(risk)}${p.reset}`, Math.max(1, W - 2))}`);
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
	rows.push(`${gutter}${p.dim}${cutLine(panelAffordance(view, phase, cursor, safer), Math.max(1, W - 2))}${p.reset}`);
	// TUI2-R1.5 11 (VD-13): a real bottom RULE, in the block's own edge
	// vocabulary — the same box-drawing run its divider already uses —
	// anchored at the gutter column. It used to be `\u2514 `: a two-cell stub
	// floating at column 1, with no rule running from it and no corner
	// above it to answer. Worse, `\u2514 ` is the cut-notice prefix everywhere
	// else in the product, so a CAPPED panel emitted two elbow rows in a
	// row meaning entirely different things. The rule reads as an edge,
	// and the cut notice above it reads as a notice.
	rows.push(`${p.dim}${"\u2500".repeat(Math.max(0, W))}${p.reset}`);
	return { rows, ...layout };
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
export function panelLead(view: PanelView, phase: PanelPhase, cursor: number): string {
	const p = palette();
	if (phase === "amend") return `${p.dim}amend› ${p.reset}`;
	// R2: an EMPTY lead emits no bytes at all — `dim + reset` around
	// nothing is eight bytes on the composer row of every frame a panel
	// is up, and the row it wraps has no content to style.
	return PANEL_IDLE_LEAD === "" ? "" : `${p.dim}${PANEL_IDLE_LEAD}${p.reset}`;
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
export function panelLeadPlain(view: PanelView, phase: PanelPhase, cursor: number): string {
	return phase === "amend" ? "amend› " : PANEL_IDLE_LEAD;
}

export function panelLeadWidth(view: PanelView, phase: PanelPhase, cursor: number): number {
	return displayWidth(panelLeadPlain(view, phase, cursor));
}

/** The status row's left text while the panel is up — the phase, not
 *  the CLI's painting status (the compositor derives it from the panel
 *  state; the "❯ run paused" etc. ride the options phase). */
// R2 (design §4, the ❯ ruling): a panel that is WAITING ON A HUMAN says
// so with the one mark that means it. `▸` is the checklist's "the
// current one" — a mark meaning two things is worse than two marks
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
	if (phase === "amend") return "⏎ send · esc back";
	// TUI2-R3v2 ③: the ask is in flight — the ONE key that still means
	// something is the one that gets you out of it.
	if (phase === "asking") return "esc cancels";
	// the same sentence the approval list carries, counting the rows THIS
	// list has (the alternatives plus the way back)
	if (phase === "safer" && safer !== undefined) {
		return `↑↓ move · ⏎ or click confirms · 1-${safer.options.length + 1} instant · esc`;
	}
	return `↑↓ move · ⏎ or click confirms · 1-${panelOptions(view).length} instant · esc`;
}


// ── TUI2-R2 ④: the pick block, its lead, its status, its affordance ──

/**
 * The pick block's rows — the prototype's C frame.
 *
 * The header says what is in effect right now, because the first
 * question anyone opening this panel has is "what am I on?". The
 * options are numbered from 1 and the number IS the key. The `t` row is
 * last and always present: a profile list is a convenience, never the
 * set of models that exist, and a picker that can only offer what
 * someone remembered to configure is a smaller product than the one it
 * replaced.
 *
 * Single-row discipline: every row CUTS, never folds — the block's
 * height is its row count (the W20 rule the #checked throw demands).
 */
export function pickBlockRows(view: PanelView, state: PickRuntime, W: number, maxRows: number): string[] {
	const p = palette();
	const spec = view.pick!;
	const rows: string[] = [`${p.dim}${"\u2500".repeat(Math.max(0, W))}${p.reset}`]; // R2: the same rule the composer and the other panels use
	const room = Math.max(1, W - 2);
	rows.push(`  ${cutLine(`${p.bold}${escapeTerminal(spec.header.split(" \u2014 ")[0] ?? spec.header)}${p.reset}${p.dim}${escapeTerminal(spec.header.slice((spec.header.split(" \u2014 ")[0] ?? "").length))}${p.reset}`, room)}`);
	if (spec.options.length === 0) {
		// the honest empty state \u2014 the caller's own copy, verbatim
		rows.push(`  ${cutLine(`${p.dim} ${escapeTerminal(spec.emptyNote ?? "no options")}${p.reset}`, room)}`);
	} else {
		// the budget: the OPENING rule, the header, the t row, the
		// affordance and the CLOSING rule — five, not four. R2 added the
		// opening rule to this block and bumped the ask panel (5→6) and the
		// approval panel (5→6) to pay for it, and missed this one: the
		// block ran two rows over its budget, and two rows of committed
		// content were scrolled irreversibly into the scrollback every time
		// `/model` opened on a tight screen. The `+N more` row is a sixth
		// when it appears, so it is paid for too.
		const chrome = 5 + (spec.options.length > Math.min(Math.max(1, maxRows - 5), PICK_MAX) ? 1 : 0);
		const budget = Math.max(1, maxRows - chrome);
		const shown = spec.options.slice(0, Math.min(budget, PICK_MAX));
		// R2: the note takes a COLUMN, not three spaces after a label of
		// whatever length this row happened to have, and the cursor row
		// wears the bar and the arrow like every other list in the
		// product. This panel was the last one still saying "selected"
		// with bold alone.
		const lead = (o: PickOption, i: number, cursor: boolean): string => `${cursor ? "\u2192" : " "} ${i + 1} ${escapeTerminal(o.label)}`;
		const widest = Math.max(...shown.map((o, i) => visibleWidth(lead(o, i, false))));
		const stop = shown.some((o) => o.note !== undefined) && widest + 2 <= Math.floor(room / 2) && room - widest - 2 >= 18 ? widest + 2 : 0;
		for (let i = 0; i < shown.length; i += 1) {
			const o = shown[i]!;
			const mark = i === state.cursor && state.phase === "options";
			const plain = lead(o, i, mark);
			const head = `${mark ? p.bold : ""}${plain}${mark ? p.reset : ""}`;
			const note =
				o.note === undefined
					? ""
					: stop > 0
						? `${" ".repeat(Math.max(1, stop - visibleWidth(plain)))}${p.dim}${widthCut(escapeTerminal(o.note), Math.max(0, room - stop))}${p.reset}`
						: `${p.dim}   ${escapeTerminal(o.note)}${p.reset}`;
			const text = cutLine(`${head}${note}`, room);
			// ONE space, like the approval and ask panels: the bar spends a
			// leading cell of its own, so a two-space unselected prefix
			// moves the digit column by one as the cursor walks — the exact
			// "a column that moves per row reads as damage" this file
			// quotes twice as its standard.
			rows.push(mark ? selectionBar(text, visibleWidth(text), W) : ` ${text}`);
		}
		if (spec.options.length > shown.length) {
			rows.push(`  ${cutLine(`${p.dim} \u2514 +${spec.options.length - shown.length} more \u2014 /model <name> takes any of them${p.reset}`, room)}`);
		}
	}
	const typing = state.phase === "custom";
	if (spec.typeHint !== undefined) {
		const tText = cutLine(`${typing ? p.bold : ""}${typing ? "\u2192" : " "} t ${p.reset}${p.dim}${escapeTerminal(spec.typeHint)}${p.reset}`, room);
		rows.push(typing ? selectionBar(tText, visibleWidth(tText), W) : ` ${tText}`);
	}
	rows.push(`  ${p.dim}${cutLine(pickAffordance(state), room)}${p.reset}`);
	rows.push(`${p.dim}${"\u2500".repeat(Math.max(0, W))}${p.reset}`);
	return rows;
}

/** The digits are the keys, so the list the panel offers is bounded by
 *  the digits there are. Beyond it, `/model <name>` still takes any
 *  profile — the panel says so rather than paginating. */
export const PICK_MAX = 9;

/** The input row's lead: the digit range while picking, the named
 *  prompt while typing one out. */
export function pickLeadPlain(view: PanelView, state: PickRuntime): string {
	if (state.phase === "custom") return "provider/model: ";
	const n = Math.min(view.pick!.options.length, PICK_MAX);
	return n === 0 ? "t> " : `1-${n}> `;
}

export function pickLead(view: PanelView, state: PickRuntime): string {
	const p = palette();
	return `${p.bold}${pickLeadPlain(view, state)}${p.reset}`;
}

/** The status row's left text \u2014 the CALLER's, because only the caller
 *  knows whether a run is paused behind this panel. */
export function pickStatus(view: PanelView): string {
	return view.statusText;
}

export function pickAffordance(state: PickRuntime): string {
	// DC-36 — the row NAMES the arrows. TUI2-R2 ④ bound ↑↓ to the pick's
	// cursor and the keys sheet has said `panels: ↑↓ move` ever since,
	// but this row — the one a human is actually looking at while the
	// panel is up — advertised only the digits. The owner read it as
	// "type the answer", which is the same lesson DC-30 filed: a hint
	// that omits the gesture is why the gesture goes unused.
	return state.phase === "custom" ? "enter commits \u00b7 esc backs out" : "\u2191\u2193 move \u00b7 digits pick \u00b7 \u23ce confirms \u00b7 esc";
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
