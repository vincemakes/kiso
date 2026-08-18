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
	/** the `t` row \u2014 typing it directly is always available, because a
	 *  list of profiles is never the list of models that exist */
	readonly typeHint: string;
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
	return hint ? `${base}${p.dim} ·${p.reset} ${p.code}${escapeTerminal(hint)}${p.reset}` : base;
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
 * The unselected row carries the block's gutter and a two-space indent;
 * the selected row is the shared selectionBar, which spends its own two
 * cells of frame. Both build their span against W−2, so the digit column
 * does not shift as the bar walks — a column that moves per row reads as
 * damage, which is the R2 picker's finding, inherited.
 */
function panelOptionRow(option: PanelOption, n: number, selected: boolean, W: number): string {
	const p = palette();
	const room = Math.max(1, W - 2);
	const plain = ` ${n} ${option.label}`;
	const text = cutLine(`${selected ? p.bold : ""}${escapeTerminal(plain)}${p.reset}`, room);
	if (!selected) return `${p.dim}│${p.reset} ${text}`;
	return selectionBar(text, visibleWidth(text), W);
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
	const gutter = `${p.dim}│${p.reset} `;
	const rows: string[] = [];
	rows.push(`${gutter}${cutLine(panelRuleText(view), Math.max(1, W - 2))}`);
	rows.push(`${gutter}${cutLine(`${p.bold}${escapeTerminal(view.title)}${p.reset}`, Math.max(1, W - 2))}`);
	// TUI2-R1.5 ⑤ (VD-11): the divider is a LABEL, not a design note. "the
	// full args — never truncated" is a sentence about the implementation,
	// addressed to whoever was building the panel; the human reading it
	// during an approval wants to know what the block below is.
	rows.push(`${cutLine(`${p.dim}─ args (full) ─${p.reset}`, Math.max(1, W - 2))}`);
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
		5 +
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
		for (let i = 0; i < safer.options.length; i += 1) {
			const o = safer.options[i]!;
			rows.push(panelOptionRow({ kind: "allow", label: `${o.command}  — ${o.why}` }, i + 1, i === safer.cursor, W));
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
	rows.push(`${p.dim}\u2514${"\u2500".repeat(Math.max(0, W - 1))}${p.reset}`);
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
	return `${p.dim}${PANEL_IDLE_LEAD}${p.reset}`;
}

/** The composer's lead while a selection list owns the keys — the quiet
 *  chevron, not a prompt for input that is not being asked for. */
const PANEL_IDLE_LEAD = "› ";

/** The lead's plain text — the editor's reflow width (the line must
 *  fit the lead + the box's walls). */
export function panelLeadPlain(view: PanelView, phase: PanelPhase, cursor: number): string {
	return phase === "amend" ? "amend› " : PANEL_IDLE_LEAD;
}

export function panelLeadWidth(view: PanelView, phase: PanelPhase, cursor: number): number {
	return displayWidth(panelLeadPlain(view, phase, cursor));
}

/** The status row's left text while the panel is up — the phase, not
 *  the CLI's painting status (the compositor derives it from the panel
 *  state; the "▸ run paused" etc. ride the options phase). */
export function panelStatus(view: PanelView, phase: PanelPhase, cursor: number): string {
	// TUI2-R3v2 ③: the frames' own words — what the panel is doing, and
	// (in the safer list) what it did.
	if (phase === "asking") return "\u25b8 asked the model for safer options";
	if (phase === "safer") return "\u25b8 asked the model for safer options";
	// TUI2-R3v2 ①: the typed phase says where the words GO. "the words ride
	// the verdict" described the plumbing to whoever wrote it; the human
	// typing needs to know the model will read this and answer with a new
	// call — which is what the v4 frame says, in those words.
	if (phase === "amend") return "▸ your note goes to the model — it will propose a new call";
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
	const gutter = `${p.dim}\u2502${p.reset} `;
	const rows: string[] = [];
	const room = Math.max(1, W - 2);
	rows.push(`${gutter}${cutLine(`${p.bold}${escapeTerminal(spec.header.split(" \u2014 ")[0] ?? spec.header)}${p.reset}${p.dim}${escapeTerminal(spec.header.slice((spec.header.split(" \u2014 ")[0] ?? "").length))}${p.reset}`, room)}`);
	if (spec.options.length === 0) {
		// the honest empty state \u2014 the caller's own copy, verbatim
		rows.push(`${gutter}${cutLine(`${p.dim} ${escapeTerminal(spec.emptyNote ?? "no options")}${p.reset}`, room)}`);
	} else {
		// the budget: the header, the t row, the affordance and the rule
		const budget = Math.max(1, maxRows - 4);
		const shown = spec.options.slice(0, Math.min(budget, PICK_MAX));
		for (let i = 0; i < shown.length; i += 1) {
			const o = shown[i]!;
			const mark = i === state.cursor && state.phase === "options";
			const head = `${mark ? p.bold : ""} ${i + 1} ${escapeTerminal(o.label)}${mark ? p.reset : ""}`;
			const note = o.note === undefined ? "" : `${p.dim}   ${escapeTerminal(o.note)}${p.reset}`;
			rows.push(`${gutter}${cutLine(`${head}${note}`, room)}`);
		}
		if (spec.options.length > shown.length) {
			rows.push(`${gutter}${cutLine(`${p.dim} \u2514 +${spec.options.length - shown.length} more \u2014 /model <name> takes any of them${p.reset}`, room)}`);
		}
	}
	rows.push(`${gutter}${cutLine(`${state.phase === "custom" ? p.bold : ""} t ${p.reset}${p.dim}${escapeTerminal(spec.typeHint)}${p.reset}`, room)}`);
	rows.push(`${gutter}${p.dim}${cutLine(pickAffordance(state), room)}${p.reset}`);
	rows.push(`${p.dim}\u2514${"\u2500".repeat(Math.max(0, W - 1))}${p.reset}`);
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
	return state.phase === "custom" ? "enter commits \u00b7 esc backs out" : "digits pick \u00b7 \u23ce confirms \u00b7 esc";
}

/** Compose a pick view. The flavor/name/title/args fields exist for the
 *  approval path and are given inert values here \u2014 the pick block
 *  reads none of them. */
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
