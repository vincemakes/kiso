/**
 * TUI2-MD — the markdown renderer. Hand-rolled, zero dependencies, and
 * deliberately a SUBSET: the constructs assistant prose actually uses,
 * rendered under the mono discipline (attributes over colours, zero
 * syntax highlighting).
 *
 * THE BLOCK-FREEZE DISCIPLINE. kiso's committed bytes are never
 * re-emitted (ADR-0046) — the terminal's own scrollback is the
 * transcript. A renderer that re-lexes the whole message per delta (the
 * shape a whole-text parser forces on you) can therefore not be used
 * here at all: it would need to repaint lines that have already left
 * the live region. So the scanner below IS the streaming state machine.
 * It consumes appended text and yields two things:
 *
 *   - CLOSED blocks: their source is final, so their render is final;
 *     the compositor commits them through the path it already had.
 *   - the OPEN TAIL block: the live region's occupant, re-rendered in
 *     place per delta, bounded by construction (one block).
 *
 * The freeze property — a closed block's rendered lines never change as
 * more text arrives — is earned by ONE rule: block boundaries are
 * decided only on COMPLETE lines. A trailing partial line renders
 * eagerly but can never close anything, because a decision taken on an
 * incomplete line can be wrong ("#" is a heading until it becomes
 * "#hashtag") and a wrong decision here is a wrong commit.
 *
 * Everything else follows: an unclosed `**` renders literal and flips
 * when it closes, but only ever inside the open block; a fence body
 * line is line-local (no highlighting means no cross-line lexer state),
 * so it closes the instant its newline arrives and long code blocks
 * never bloat the live region; a table re-layouts as rows stream, and
 * only inside the tail.
 *
 * The style table is the round's normative one (the owner's circled
 * group D): the BLOCK half is `blockBody` below, the INLINE half is
 * `inlineSpans`, and every entry is pinned by a fixture rather than
 * described twice.
 */

import { headingRule, palette } from "./render.js";
import { breakable, charWidth, displayWidth } from "./width.js";
import { escapeTerminal } from "./render.js";
import { visibleWidth } from "./components.js";

/** The block kinds. `fence-open`/`fence-line` are separate kinds on
 *  purpose: a fence's rows must be able to freeze ONE AT A TIME, and
 *  MD-1.4's `code-line` is the same shape for the same reason. */
export type MdKind = "para" | "heading" | "list" | "table" | "quote" | "rule" | "fence-open" | "fence-line" | "fence-close" | "code-line" | "refdef";

/** One block: its SOURCE lines, never a rendered form. The render is a
 *  pure function of (block, width), which is what makes the freeze
 *  property a property of the scanner alone. */
export interface MdBlock {
	readonly kind: MdKind;
	readonly lines: readonly string[];
	/** a blank row precedes this block — the markdown rhythm, owned here
	 *  rather than by the compositor's W11 join formula (which reads row
	 *  COUNTS and so cannot express "no blank between two rows of one
	 *  fence"). */
	readonly gap: boolean;
	/** the fence's language tag; "" everywhere else. */
	readonly lang: string;
}

// ---- line classification -------------------------------------------

/** E2 — the rail a fenced block is drawn with. Three backticks: what
 *  the model wrote, and what a human gets back when they copy the block
 *  out of the terminal. */
const RAIL = "\u0060\u0060\u0060";

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** ATX only, and the space is REQUIRED: `#hashtag` is prose. */
const HEADING = /^ {0,3}(#{1,6}) +(\S.*)$/;
const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,}) *$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const TABLE = /^ {0,3}\|/;
/** A link reference definition: `[label]: url "title"` (the title may be
 *  double-, single- or paren-quoted, and may be absent). Graphite R2f
 *  (owner, 2026-09-30): it is its own block, one row per definition, dim.
 *  DECLARED DEVIATION: CommonMark lets a definition not interrupt a
 *  paragraph; here a complete line that is one starts its own block,
 *  because the decision is taken line by line and a model writes its
 *  definitions after a blank anyway. */
const REFDEF = /^ {0,3}\[([^\]\n]+)\]:[ \t]*(\S+)(?:[ \t]+("[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
/** MD-1.4 — a SETEXT underline. Only meaningful under an OPEN paragraph,
 *  which is the only place `#line` consults it. Before this, `=` was not a
 *  construct at all, so it leaked into the paragraph's own text, and a `-`
 *  underline classified as a RULE, so the heading's text became a
 *  paragraph with a full-width divider under it. Both outputs were
 *  CORRUPTED, not merely unstyled, and a guess printed into scrollback is
 *  indistinguishable from a fact. */
const SETEXT = /^ {0,3}(=+|-+) *$/;
/** MD-1.4 — an indented code block's line. Four columns, the markdown
 *  marker; tested AFTER `ITEM`, so a nested list written with four spaces
 *  stays a list. That is a deliberate deviation, and the reason is
 *  frequency: a four-space nested list is far more common in model prose
 *  than an indented code block that opens with a list marker. A TAB indent
 *  is not recognised here (it stays prose) — stated rather than implied.
 *
 *  MD1-F4 — and the indent alone is NOT enough: a line that would classify
 *  here is PROSE when the most recent block is a `list`. For `1. ` the
 *  content indent is three columns, so a line indented four after a blank
 *  is the item's continuation paragraph and code inside that item would
 *  need seven. Models write that shape constantly — numbered steps, each
 *  with an explanatory paragraph under it — and rendering it verbatim
 *  destroyed the reflow and kept a four-space indent. `code-line` is
 *  therefore reached only after a paragraph, heading, rule, quote, table
 *  or fence, or at the start of a message.
 *
 *  MD1-F4b — and the context OUTLIVES the paragraph it demoted. A demoted
 *  block is the item's continuation, so closing one leaves the context as
 *  `list` and the SECOND and third indented paragraphs under one item are
 *  prose as well. An earlier version of this rule consulted only the most
 *  recent block, and a numbered step with two paragraphs under it rendered
 *  the second one verbatim — the same defect one paragraph later. The
 *  context ends where it should: at the first unindented block, or at a
 *  heading, rule, quote, table or fence, each of which names its own kind.
 *
 *  Two consequences, stated rather than discovered: an indented code block
 *  nested INSIDE a list item is not recognised (it renders as the item's
 *  paragraph), and blank lines inside an indented block collapse to ONE gap
 *  row, exactly as they do between paragraphs — two blank lines in a code
 *  block come back as one. */
const CODE = /^ {4,}/;

/** The kind a line would START. null = blank (a block separator). */
function classify(line: string): MdKind | null {
	if (line.trim() === "") return null;
	if (FENCE.test(line)) return "fence-open";
	if (RULE.test(line)) return "rule";
	if (HEADING.test(line)) return "heading";
	if (QUOTE.test(line)) return "quote";
	if (TABLE.test(line)) return "table";
	if (REFDEF.test(line)) return "refdef";
	if (ITEM.test(line)) return "list";
	if (CODE.test(line)) return "code-line";
	return "para";
}

/** Can `line` JOIN an open block of this kind? Headings, rules and the
 *  fence rows are single-line blocks and never take a second line. */
function joins(kind: MdKind, line: string): boolean {
	const c = classify(line);
	if (c === null) return false; // a blank closes everything
	switch (kind) {
		case "para":
			// MD-1.4: an indented line CONTINUES a paragraph rather than opening
			// a code block — indented code cannot interrupt a paragraph, so a
			// `code-line` only ever starts one after a blank.
			return c === "para" || c === "code-line";
		case "list":
			// a list item's continuation must be INDENTED — an unindented
			// paragraph after a list starts a paragraph (the lazy-continuation
			// rule is a documented deviation: predictable beats compliant when
			// the output is committed).
			return c === "list" || ((c === "para" || c === "code-line") && /^[ \t]/.test(line));
		case "table":
			return c === "table";
		case "quote":
			return c === "quote";
		case "refdef":
			return c === "refdef";
		default:
			return false;
	}
}

/** A heading's LEVEL and TEXT, ATX or setext. A setext block's lines are
 *  the paragraph's own with the underline last — the SOURCE, never a
 *  rewritten ATX form, so the block still says what the model sent. */
function headingShape(lines: readonly string[]): { level: number; text: string } {
	const last = lines[lines.length - 1] ?? "";
	if (lines.length > 1 && SETEXT.test(last)) return { level: last.trimStart().startsWith("=") ? 1 : 2, text: lines.slice(0, -1).join(" ") };
	const m = HEADING.exec(lines[0] ?? "");
	return { level: (m?.[1] ?? "#").length, text: m?.[2] ?? lines[0] ?? "" };
}

/** The fence marker a line opens with (``` or ~~~, 3+). */
function fenceMark(line: string): string {
	return FENCE.exec(line)?.[1] ?? "```";
}

/** A line that CLOSES a fence: the same char, at least as long, alone. */
function closesFence(line: string, mark: string): boolean {
	const m = FENCE.exec(line);
	return m !== null && m[1]!.startsWith(mark[0]!) && m[1]!.length >= mark.length && m[2]!.trim() === "";
}

/** The partial line is nothing but the HEAD of a closing fence — the
 *  one visible flicker in fence-close streaming (a stray ``` `` ``` on
 *  screen for a frame). Both reference implementations trim it. */
function partialClose(partial: string, mark: string): boolean {
	const t = partial.trim();
	return t !== "" && t.length <= mark.length && t.split("").every((c) => c === mark[0]);
}

// ---- the scanner / streaming state machine --------------------------

interface OpenBlock {
	kind: MdKind;
	lines: string[];
	gap: boolean;
	lang: string;
	/** MD1-F4b — this block was DEMOTED from `code-line` to `para` because a
	 *  list preceded it, so it is the list item's continuation and the list
	 *  context must outlive it. Scanner state, never part of the block's
	 *  identity: `frozen` does not carry it, because two documents that
	 *  produce the same block must produce the same bytes. */
	cont: boolean;
}

function frozen(b: OpenBlock, extra?: string): MdBlock {
	return { kind: b.kind, lines: extra === undefined ? [...b.lines] : [...b.lines, extra], gap: b.gap, lang: b.lang };
}

export class MdStream {
	#closed: MdBlock[] = [];
	#open: OpenBlock | null = null;
	#partial = "";
	/** the opener's marker while inside a fence; null outside one. */
	#fence: string | null = null;
	/** blocks STARTED so far — the gap rule's only input (the first block
	 *  of a message opens tight; every later one carries its own blank). */
	#started = 0;
	/** MD-1.4 / MD1-F4 — the kind of the most recent BLOCK, which is what
	 *  decides whether an indented line is code or prose. Kept HERE rather
	 *  than read back off `#closed`: the tail block is not in `#closed` at
	 *  all, and `blocks()` hands out fresh objects. It is only ever read
	 *  while `#open` is null, so "most recent" is never ambiguous. */
	#lastKind: MdKind | null = null;
	/** MD-1.4 — was the last COMPLETE line an indented code line? Each such
	 *  line is its own block (line-local, so a long indented block streams
	 *  through the live region exactly as a fence body does), which means the
	 *  gap rule needs to know that the block before it was the same block:
	 *  the FIRST line of a block carries the blank, the rest do not. */
	#code = false;

	/** Append streamed text. Only COMPLETE lines reach the state machine. */
	push(text: string): void {
		// the renderer consumes already-scrubbed text and never re-introduces
		// ESC from data: the styling below is applied by this module, never
		// carried in the content.
		this.#partial += escapeTerminal(text);
		for (let at = this.#partial.indexOf("\n"); at >= 0; at = this.#partial.indexOf("\n")) {
			this.#line(this.#partial.slice(0, at));
			this.#partial = this.#partial.slice(at + 1);
		}
	}

	/** The message ended: the trailing partial line is a complete line
	 *  after all, and the open block closes. */
	end(): void {
		if (this.#partial !== "") {
			this.#line(this.#partial);
			this.#partial = "";
		}
		this.#shut();
		this.#fence = null;
	}

	/** Every block so far: `closed()` of them are FINAL, and at most one
	 *  open tail follows. Fresh objects — a closed block's source can
	 *  never be reached through this. */
	blocks(): readonly MdBlock[] {
		const out: MdBlock[] = [...this.#closed];
		const p = this.#partial;
		if (this.#fence !== null) {
			if (p !== "" && !partialClose(p, this.#fence)) out.push({ kind: "fence-line", lines: [p], gap: false, lang: "" });
			return out;
		}
		if (this.#open !== null) {
			out.push(p === "" ? frozen(this.#open) : frozen(this.#open, p));
			return out;
		}
		const { kind: k } = this.#kindOf(p);
		if (k !== null) out.push({ kind: k, lines: [p], gap: this.#started > 0 && !(k === "code-line" && this.#code), lang: k === "fence-open" ? fenceLang(p) : "" });
		return out;
	}

	/** MD1-F4 — the kind a line starts HERE: `classify` plus the one piece of
	 *  context that decides code from prose, an indented line after a list
	 *  being the list item's continuation paragraph. `demoted` says the
	 *  answer CAME from that context, which is what the open block is marked
	 *  with so the context can outlive it (MD1-F4b). */
	#kindOf(line: string): { kind: MdKind | null; demoted: boolean } {
		const k = classify(line);
		const demoted = k === "code-line" && this.#lastKind === "list";
		return { kind: demoted ? "para" : k, demoted };
	}

	/** How many leading blocks are CLOSED — the commit-eligible count. */
	closed(): number {
		return this.#closed.length;
	}

	#line(line: string): void {
		// MD-1.4: `#code` describes the PREVIOUS complete line, so it is read
		// and cleared here and set again only on the code-line path.
		const wasCode = this.#code;
		this.#code = false;
		if (this.#fence !== null) {
			// E2: the closer emits its OWN block now. The rule it used to
			// obey — "a bottom border is drawn only by an actual close, and
			// under committed lines a phantom one would be a lie the
			// force-commit path could freeze" — is UNCHANGED and is why this
			// is safe: the rail appears here, on an actual close, and never
			// before. An unterminated fence still draws no bottom, which is
			// the truth about an unterminated fence.
			if (closesFence(line, this.#fence)) {
				this.#fence = null;
				this.#push({ kind: "fence-close", lines: [line], gap: false, lang: "" });
				return;
			}
			this.#push({ kind: "fence-line", lines: [line], gap: false, lang: "" });
			return;
		}
		// MD-1.4 — a SETEXT underline closes the OPEN paragraph as a HEADING.
		// The decision is taken on the COMPLETE underline line, which is the
		// freeze rule itself: the paragraph has not closed yet when the
		// underline arrives, so no committed row changes. This is also the
		// whole of the `rule` interaction — a `-` underline outranks RULE
		// exactly where a paragraph is open, which is the only condition under
		// which it could be an underline at all. The block keeps its SOURCE
		// lines, underline last; `headingShape` reads the level off it.
		//
		// One interaction worth naming rather than leaving to be discovered:
		// the live cell holding an OPEN paragraph is eligible for the
		// compositor's force-commit (`#capLive` excludes only a RUNNING tool
		// card), so on a short terminal a long paragraph can reach scrollback
		// before its underline arrives — and the promotion then applies to
		// rows that are already committed and plain. Pre-existing class (the
		// report's §4.9 escalated risk, FINDING TUI2-MD-1's neighbourhood);
		// what is new here is that the flip it misses is a STYLE flip. Not
		// reproduced in this round.
		if (this.#open !== null && this.#open.kind === "para" && SETEXT.test(line)) {
			this.#closed.push({ kind: "heading", lines: [...this.#open.lines, line], gap: this.#open.gap, lang: "" });
			this.#open = null;
			this.#lastKind = "heading";
			return;
		}
		const { kind: k, demoted } = this.#kindOf(line);
		if (k === null) {
			this.#shut();
			return;
		}
		if (this.#open !== null && joins(this.#open.kind, line)) {
			this.#open.lines.push(line);
			return;
		}
		this.#shut();
		if (k === "fence-open") {
			this.#fence = fenceMark(line);
			this.#push({ kind: k, lines: [line], gap: this.#started > 0, lang: fenceLang(line) });
			return;
		}
		if (k === "heading" || k === "rule") {
			this.#push({ kind: k, lines: [line], gap: this.#started > 0, lang: "" });
			return;
		}
		if (k === "code-line") {
			// line-local like a fence body: final the moment its newline lands.
			// Only the FIRST line of the block carries the blank above it.
			this.#push({ kind: k, lines: [line], gap: this.#started > 0 && !wasCode, lang: "" });
			this.#code = true;
			return;
		}
		this.#open = { kind: k, lines: [line], gap: this.#started > 0, lang: "", cont: demoted };
		this.#started += 1;
	}

	/** A block that is final the moment its line is. */
	#push(b: MdBlock): void {
		this.#closed.push(b);
		this.#started += 1;
		this.#lastKind = b.kind;
	}

	#shut(): void {
		if (this.#open === null) return;
		this.#closed.push(frozen(this.#open));
		// MD1-F4b — a DEMOTED block is the list item's continuation, so the
		// list context outlives it: the second and third indented paragraphs
		// under one item are prose too. The context ends where it should, at
		// the first unindented block or at a heading, rule, quote, table or
		// fence, because those set `#lastKind` to their own kind.
		this.#lastKind = this.#open.cont ? "list" : this.#open.kind;
		this.#open = null;
	}
}

function fenceLang(line: string): string {
	return (FENCE.exec(line)?.[2] ?? "").trim();
}

// ---- rendering ------------------------------------------------------

/** The whole message at once — the freeze property's oracle, and the
 *  path a non-streaming caller takes. */
export function renderMarkdown(text: string, W: number, opts: { readonly hardBreaks?: boolean } = {}): string[] {
	const s = new MdStream();
	s.push(text);
	s.end();
	return s.blocks().flatMap((b) => renderBlock(b, W, opts.hardBreaks === true));
}

/** One block's screen rows. Pure in (block, W) — this is the whole
 *  freeze guarantee: same source, same width, same bytes, forever. */
export function renderBlock(b: MdBlock, W: number, hardBreaks = false): string[] {
	return withGap(b, blockBody(b, Math.max(1, W), 0, "", hardBreaks));
}

/** Graphite §5 (R2b): a heading block's level, or null — the prose column
 *  puts `§` in the mark column beside a `##`, which is outside the block. */
export function headingLevel(b: MdBlock): number | null {
	return b.kind === "heading" ? headingShape(b.lines).level : null;
}

/** Graphite §5 (R2b): the Graphite styles apply where the palette has its
 *  colours; elsewhere (the unknown ground, no colour) the mono forms stay,
 *  since a marker is the only carrier that survives there (DC-4). */
const graphite = (): boolean => palette().blue !== "";

/** `####` and deeper are upper case — outside code spans, whose text is
 *  literal (an identifier upper-cased is a different identifier). */
function upperOutsideCode(text: string): string {
	return text.replace(/(`[^`]*`)|([^`]+)/g, (_m, code: string | undefined, rest: string | undefined) => code ?? (rest ?? "").toUpperCase());
}

/** The markdown rhythm: a block that carries `gap` opens with a blank row.
 *  One helper because there are two callers — this module's entry point and
 *  the nested render inside a quote, which has to reproduce the rhythm of
 *  the blocks it contains. */
function withGap(b: MdBlock, rows: readonly string[]): string[] {
	return b.gap ? ["", ...rows] : [...rows];
}

/** MD-1.5 — how deep a quote may nest before it stops being rendered as
 *  blocks. A `>>>>>` quote in a narrow terminal spends two columns per
 *  level, and past this it degrades to the flattened form rather than
 *  recursing on nothing. Cheap insurance: the wrapper already degrades an
 *  over-wide prefix instead of throwing. */
const QUOTE_DEPTH = 4;

/** `base` is the style the text of a paragraph or list starts in and
 *  returns to (a quote's italic `ink2`); `hard` keeps every source line of
 *  a paragraph a line of its own (the person's own words: a line break
 *  they typed is theirs). */
function blockBody(b: MdBlock, W: number, depth: number, base = "", hard = false): string[] {
	const p = palette();
	const styled = (t: string): string => (base === "" ? inlineSpans(t, "") : `${base}${inlineSpans(t, base)}${p.reset}`);
	switch (b.kind) {
		case "heading": {
			// DC-4: the LEVEL is information and it used to be discarded —
			// `#`, `##` and `###` all rendered as the same bold line, so a
			// structured answer arrived flat. Levels are NOT differentiated
			// by colour: 1 adds an underline, 2 is bold alone, and 3 and
			// below print their own `###`, because attributes have run out
			// and a marker is the only carrier that survives a pipe. A
			// `**bold**` inside a heading is still a no-op, which is the mono
			// discipline paying for itself.
			const { level, text } = headingShape(b.lines);
			if (graphite()) {
				// Graphite §5 (R2b) — DECLARED REVERSAL of DC-4's "levels are
				// NOT differentiated by colour": `#` bold gold over a rule that
				// fades from gold-mark, `##` bold blue (its `§` in the mark
				// column, outside the block), `###` bold ink, `####` and deeper
				// bold dim in upper case. No level prints its own `#`s. The
				// mono forms below stay where there is no colour to carry it.
				const tone = level === 1 ? p.gold : level === 2 ? p.blue : level >= 4 ? p.dim : "";
				const style = `${p.bold}${tone}`;
				const words = level >= 4 ? upperOutsideCode(text) : text;
				const rows = wrap(`${style}${inlineSpans(words, style)}${p.reset}`, W, "", "");
				return level === 1 ? [...rows, headingRule(Math.max(1, Math.min(40, W)))] : rows;
			}
			const style = level === 1 ? `${p.bold}${p.underline}` : p.bold;
			const marker = level >= 3 ? `${"#".repeat(level)} ` : "";
			return wrap(`${style}${marker}${inlineSpans(text, style)}${p.reset}`, W, "", "");
		}
		case "rule": {
			// R2: the rule at the block's own width. The 28 was a guess that
			// read as a short line rather than a divider.
			//
			// MD-1.6 — and it takes the BLOCK INSET, two columns, like a fence
			// body. Without it this row and `boxTop` emitted identical bytes —
			// same glyph, same dim, same full width — so in scrollback you could
			// not tell "the model drew a divider" from "kiso closed a panel".
			// The fix is the inset and NOT a new glyph: R3 (owner, 2026-08-27)
			// ruled the rule is a solid hairline everywhere, "one line, one
			// weight, no exceptions to remember", and a new glyph would reverse
			// that. Content and chrome differ by their LEFT EDGE instead, which
			// is how every other register is told apart under R13 E3.
			//
			// The inset is chrome this renderer generates, so at a width that
			// cannot pay for it, it yields — the same rule `mdWrap` applies to
			// an over-wide prefix.
			const inset = W >= 4 ? "  " : "";
			// Graphite §5 (R2b) — DECLARED REVERSAL of R3's "the rule is a
			// solid hairline everywhere" for the MODEL's rule only: three
			// spaced dots in `rail`, so a divider in an answer can never be
			// taken for kiso's own chrome (the composer's rules, a panel's).
			if (graphite()) return [`${inset}${p.rail}${W - inset.length >= 7 ? "\u00b7  \u00b7  \u00b7" : "\u00b7"}${p.fgEnd}`];
			return [`${inset}${p.dim}${"\u2500".repeat(Math.max(1, W - inset.length))}${p.reset}`];
		}
		case "fence-open":
			// E2: the RAIL, not a gutter. A block drawn with ``` is still a
			// fenced block when a human selects it and pastes it somewhere
			// else; a block drawn with a gutter is not. Zero highlighting —
			// which is exactly what makes a fence body line committable on
			// its own.
			return [`${p.dim}${RAIL}${b.lang}${p.reset}`];
		case "fence-close":
			// only ever reached by an ACTUAL close (see MdStream#line): an
			// unterminated fence draws no bottom, which is the truth about
			// an unterminated fence.
			return [`${p.dim}${RAIL}${p.reset}`];
		case "fence-line":
		case "code-line": {
			// a fence body's INDENTATION is its content. The wrapper drops
			// leading spaces \u2014 right for prose, a lie for code \u2014 so the indent
			// rides as the row prefix instead, and a wrapped long line hangs
			// under it rather than returning to the gutter.
			const src = (b.lines[0] ?? "").replace(/\t/g, "    ");
			const indent = /^ */.exec(src)![0];
			// MD-1.4: a fence body insets under its own ``` rails. An indented
			// code block has no rails, so it takes no gutter either: its four
			// spaces ARE the marker the model wrote, and a block that pastes
			// back as indented code is the copy-fidelity goal. Saying "verbatim"
			// twice would cost four columns and buy nothing.
			const gutter = b.kind === "fence-line" ? "  " : "";
			// DC-3: a fenced BODY carries no colour token. It used to take
			// `code` — 1.54:1 on a white terminal, applied to whole blocks,
			// which made the code the model just wrote the least readable
			// thing on screen. The block's own ``` RAILS already say "this
			// is verbatim" (E2 replaced the `│` gutter this comment used to
			// name with them); saying it twice cost legibility and bought
			// nothing.
			// Graphite §5 (R2c, owner 2026-09-29: "no ground — keep it blue,
			// as the design has it") — DECLARED REVERSAL of DC-3's "a fenced
			// body carries no colour token": DC-3 removed a 1.54:1 grey, and
			// `blue` reads at the text floor on both grounds. The rails stay
			// (E2: a copied block is still fenced); there is no ground.
			const [on, off] = p.blue !== "" ? [p.blue, p.fgEnd] : ["", ""];
			return foldLineWidth(src.slice(indent.length), W - visibleWidth(gutter), indent).map((r) => `${gutter}${on}${r}${off}`);
		}
		case "quote":
			return quoteRows(b, W, depth);
		case "list":
			return listRows(b, W, base);
		case "table":
			return tableRows(b, W);
		case "refdef":
			return b.lines.flatMap((l) => refdefRows(l, W));
		default:
			// a paragraph's soft line breaks are spaces — the block reflows at
			// the terminal's width, which is the whole point of rendering it.
			// The person's own words keep the breaks they typed (`hard`).
			if (hard) return b.lines.flatMap((l) => wrap(styled(l), W, "", ""));
			return wrap(styled(b.lines.join(" ")), W, "", "");
	}
}

/** Graphite R2f — one reference definition, as a row of its own:
 *  `[label] url · title`, dim; the url and the title are data, never
 *  styled. A streamed definition renders the moment its line completes,
 *  and a reference to it earlier in the text has already frozen — which
 *  is why a reference link shows its text and its label, not the url. */
function refdefRows(line: string, W: number): string[] {
	const p = palette();
	const m = REFDEF.exec(line);
	if (m === null) return wrap(line, W, "", "");
	const title = m[3] === undefined ? "" : ` \u00b7 ${m[3].slice(1, -1)}`;
	return wrap(`${p.dim}[${m[1]}] ${m[2]}${title}${p.reset}`, W, "", "  ");
}

/**
 * The inline pass — the mono style table applied to one block's text.
 *
 * Scoped to `**bold**`, `*italic*`, `` `code` ``, `[text](url)` and the
 * backslash escape, with two rules that matter more than coverage:
 *
 *   RAW UNTIL CLOSED — an opener with no closer in this text stays
 *   literal. That is what lets a half-streamed `**` show its asterisks
 *   and flip the instant the closer lands, inside the live block and
 *   nowhere else.
 *
 *   CLOSE BACK TO `base` — the block's own style (a heading's bold, a
 *   quote's dim) is passed in, and every span reopens it on the way
 *   out, so a nested span can never strand it. Italic is the one span
 *   that closes surgically (SGR 23), because it can.
 *
 * Graphite R2f (owner, 2026-09-30) adds `***bold italic***`, code spans
 * of any backtick run, a link's title (read and dropped), `<autolinks>`,
 * `![images]` (named: `image` dim, the alt as a link, the url dim),
 * `[reference][links]` (the text as a link, the label dim) and `<br>` (a
 * line break).
 *
 * Documented deviations from CommonMark: `_` never emphasizes (it is a
 * character in identifiers far more often than a marker in prose);
 * emphasis does not nest across a code span; `~~` makes its text dim
 * (R2b), never SGR 9, whose terminal support is too fragmented to
 * promise — Apple Terminal draws none; a shortcut reference `[label]`
 * stays literal.
 */
export function inlineSpans(text: string, base: string): string {
	const p = palette();
	/** a link's words: `blue` and underlined on a known ground (the base
	 *  style reopened after them), bold off one */
	const linkWords = (t: string): string => (p.blue !== "" ? `${p.blue}${p.underline}${t}${p.underlineEnd}${p.fgEnd}${base}` : `${p.bold}${t}${p.reset}${base}`);
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i]!;
		if (ch === "\\" && i + 1 < text.length && ESCAPABLE.test(text[i + 1]!)) {
			out += text[i + 1];
			i += 2;
			continue;
		}
		if (ch === "`") {
			// Graphite R2f: a code span opens with a RUN of backticks and
			// closes at the next run of the SAME length (CommonMark), so
			// ``` `` `x` `` ``` quotes its backticks; one space inside each end
			// is padding and comes off. A run with no closer is literal.
			let n = 1;
			while (text[i + n] === "`") n += 1;
			const end = codeCloser(text, i + n, n);
			if (end < 0) {
				out += text.slice(i, i + n);
				i += n;
				continue;
			}
			let body = text.slice(i + n, end);
			if (body.length >= 2 && body.startsWith(" ") && body.endsWith(" ") && body.trim() !== "") body = body.slice(1, -1);
			// a code span's content is LITERAL — no markers inside it mean
			// anything, which is what makes `x | y` survive a table split
			// DC-3: inline code is a SURFACE (`wash`), closed with washEnd
			// rather than a reset so the span composes inside a heading's
			// or a quote's own style.
			// Graphite §5 (R2b): `blue`, no ground — like a code block (owner,
			// 2026-09-29, choosing between the prototype's light blue ground
			// and none, side by side in Apple Terminal)
			out += p.blue !== "" ? `${p.blue}${body}${p.fgEnd}${base}` : `${p.wash}${body}${p.washEnd}${base}`;
			i = end + n;
			continue;
		}
		// Graphite R2f (owner, 2026-09-30): `<br>` is a line break wherever it
		// stands — GitHub's reading; in a table cell the cell grows a row. The
		// wrapper breaks at the newline (mdWrap's hard token).
		if (ch === "<") {
			const br = BR.exec(text.slice(i, i + 8));
			if (br !== null) {
				out += "\n";
				i += br[0].length;
				continue;
			}
			// an autolink — `<https://…>`, `<mailto:…>`, `<a@b.c>` — is the
			// address itself, as a link, without its brackets
			const auto = AUTOLINK.exec(text.slice(i));
			if (auto !== null) {
				out += linkWords(auto[1]!);
				i += auto[0].length;
				continue;
			}
		}
		// Graphite R2f (owner, 2026-09-30): a terminal cannot draw an image, so
		// it is named — `image` dim, the alt text as a link, the url dim
		if (ch === "!" && text[i + 1] === "[") {
			const img = LINK.exec(text.slice(i + 1));
			const ref = img === null ? REFLINK.exec(text.slice(i + 1)) : null;
			if (img !== null || ref !== null) {
				const alt = (img ?? ref)![1]!;
				const where = img !== null ? ` (${img[2]})` : ref![2] !== "" ? ` [${ref![2]}]` : "";
				out += `${p.dim}image${p.dim === "" ? "" : `${p.reset}${base}`}${alt === "" ? "" : ` ${linkWords(alt)}`}${where === "" ? "" : `${p.dim}${where}${p.dim === "" ? "" : `${p.reset}${base}`}`}`;
				i += 1 + (img ?? ref)![0].length;
				continue;
			}
		}
		if (text.startsWith("***", i)) {
			// Graphite R2f: `***x***` is bold AND italic
			const end = closerAt(text, i + 3, "***");
			if (end >= 0) {
				out += `${p.bold}${p.italic}${inlineSpans(text.slice(i + 3, end), `${base}${p.bold}${p.italic}`)}${p.italicEnd}${p.reset}${base}`;
				i = end + 3;
				continue;
			}
		}
		if (text.startsWith("**", i)) {
			let end = closerAt(text, i + 2, "**");
			// Graphite R2f: the bold closes at the END of an asterisk run, so
			// `**a *b***` closes the italic inside it first (CommonMark's reading)
			while (end >= 0 && text[end + 2] === "*") end += 1;
			if (end >= 0) {
				out += `${p.bold}${inlineSpans(text.slice(i + 2, end), `${base}${p.bold}`)}${p.reset}${base}`;
				i = end + 2;
				continue;
			}
		}
		if (ch === "*") {
			const end = closerAt(text, i + 1, "*");
			if (end >= 0) {
				out += `${p.italic}${inlineSpans(text.slice(i + 1, end), `${base}${p.italic}`)}${p.italicEnd}`;
				i = end + 1;
				continue;
			}
		}
		// Graphite §5 (R2b) — DECLARED REVERSAL of "`~~` is not a construct
		// at all": struck text is `dim`, the prototype's form. Not SGR 9 —
		// Apple Terminal draws none (checked, 2026-09-29) — and only where
		// dim exists: without it the markers are the only carrier.
		if (text.startsWith("~~", i) && p.dim !== "") {
			const end = closerAt(text, i + 2, "~~");
			if (end >= 0) {
				out += `${p.dim}${inlineSpans(text.slice(i + 2, end), `${base}${p.dim}`)}${p.reset}${base}`;
				i = end + 2;
				continue;
			}
		}
		if (ch === "[") {
			const link = LINK.exec(text.slice(i));
			if (link !== null) {
				// the text bright, the url dim in parentheses. NO OSC 8 this
				// round: a hyperlink escape is bytes the human cannot see, and
				// the byte discipline gets to decide that separately.
				// Graphite §5 (R2b): the text `blue` and underlined, the url dim
				// after it. Still no OSC 8: Apple Terminal draws an OSC 8 link as
				// plain text (checked in the owner's terminal, 2026-09-29).
				out += p.blue !== ""
					? `${p.blue}${p.underline}${link[1]}${p.underlineEnd}${p.fgEnd}${p.dim} (${link[2]})${p.reset}${base}`
					: `${p.bold}${link[1]}${p.reset}${p.dim} (${link[2]})${p.reset}${base}`;
				i += link[0].length;
				continue;
			}
			// Graphite R2f (owner, 2026-09-30): `[text][label]` — the url is
			// defined elsewhere, often below, and a row once drawn never
			// changes; so the text reads as a link and the label says where its
			// definition is (drawn dim, as its own row, when it arrives)
			const ref = REFLINK.exec(text.slice(i));
			if (ref !== null) {
				out += `${linkWords(ref[1]!)}${ref[2] === "" ? "" : `${p.dim} [${ref[2]}]${p.dim === "" ? "" : `${p.reset}${base}`}`}`;
				i += ref[0].length;
				continue;
			}
		}
		out += ch;
		i += 1;
	}
	return out;
}

const ESCAPABLE = /[\\`*_~[\]()#|+.!<>-]/;
/** `[text](url)`, and (R2f) a title after the url — `"…"`, `'…'` or `(…)`
 *  — which a terminal has no hover to show, so it is read and dropped. */
const LINK = /^\[([^\]\n]*)\]\(([^)\s\n]*)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*\)/;
/** R2f: `[text][label]` and `[text][]`. The shortcut `[label]` alone is
 *  left literal — a bracketed word in prose is far more common. */
const REFLINK = /^\[([^\]\n]+)\]\[([^\]\n]*)\]/;
/** R2f: `<scheme:…>` and `<a@b.c>`. */
const AUTOLINK = /^<((?:https?|ftp):\/\/[^\s<>]+|mailto:[^\s<>]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>/;
/** R2f: `<br>`, `<br/>`, `<br />`, any case. */
const BR = /^<br[ \t]*\/?>/i;

/** The start of the next run of exactly `n` backticks at or after
 *  `from`, or −1 — a longer or shorter run is content. */
function codeCloser(text: string, from: number, n: number): number {
	for (let i = text.indexOf("`", from); i >= 0; ) {
		let m = 1;
		while (text[i + m] === "`") m += 1;
		if (m === n) return i;
		i = text.indexOf("`", i + m);
	}
	return -1;
}

/** The closing delimiter for an emphasis opener at `from`, or −1.
 *  Strict on both edges: an opener followed by a space, or a closer
 *  preceded by one, is arithmetic or prose, not emphasis (`2 * 3 * 4`
 *  must survive). An empty span is not a span. */
function closerAt(text: string, from: number, delim: string): number {
	if (from >= text.length || text[from] === " ") return -1;
	for (let i = from; i >= 0; ) {
		const at = text.indexOf(delim, i);
		if (at < 0) return -1;
		if (at > from && text[at - 1] !== " " && !(delim === "*" && text[at - 1] === "*")) return at;
		i = at + delim.length;
	}
	return -1;
}

// ---- the table tokenizer (the two convergent patches) ---------------

/** Split a table line into cells. The `|` walls are found on the RAW
 *  line, but a pipe INSIDE a code span is content — two independent
 *  reference implementations both patched exactly this, because a
 *  command in a cell (`grep a | wc`) is common and splitting it puts
 *  the human's own text in the wrong column. A backslash-escaped pipe
 *  is content too. */
export function splitCells(line: string): string[] {
	const cells: string[] = [];
	let cur = "";
	let code = false;
	const body = line.trim();
	for (let i = 0; i < body.length; i += 1) {
		const ch = body[i]!;
		if (ch === "\\" && i + 1 < body.length) {
			cur += ch + body[i + 1];
			i += 1;
			continue;
		}
		if (ch === "`") code = !code;
		if (ch === "|" && !code) {
			cells.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	cells.push(cur);
	// the leading and trailing walls produce empty edge cells
	if (cells.length > 0 && cells[0]!.trim() === "") cells.shift();
	if (cells.length > 0 && cells[cells.length - 1]!.trim() === "") cells.pop();
	return cells.map((c) => c.trim());
}

export type MdAlign = "left" | "center" | "right";

export interface MdTable {
	readonly header: readonly string[];
	readonly align: readonly MdAlign[];
	readonly rows: readonly (readonly string[])[];
}

const DELIM_CELL = /^:?-{1,}:?$/;

/** The table shape, or null when these lines are NOT a table.
 *
 *  Two rejections, both borrowed: a second line that is not a delimiter
 *  row means this is prose that contains pipes; and a body row carrying
 *  MORE columns than the header is malformed — rendering it would have
 *  to guess where the extra content belongs, and a guess printed into
 *  scrollback is indistinguishable from a fact. Rejected tables fall
 *  back to their own source bytes, which are still valid markdown. */
export function tableShape(lines: readonly string[]): MdTable | null {
	if (lines.length < 2) return null;
	const header = splitCells(lines[0]!);
	const delim = splitCells(lines[1]!);
	if (header.length === 0 || delim.length !== header.length) return null;
	if (!delim.every((c) => DELIM_CELL.test(c))) return null;
	const align = delim.map<MdAlign>((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"));
	const rows: string[][] = [];
	for (const line of lines.slice(2)) {
		const cells = splitCells(line);
		if (cells.length > header.length) return null;
		while (cells.length < header.length) cells.push(""); // a short row is padded — nothing is invented
		rows.push(cells);
	}
	return { header, align, rows };
}

/** The list: `•` normalization, numbers kept, 2 spaces per nesting
 *  level, and the HANGING INDENT — a wrapped item's continuation lines
 *  align to the text column, never back to the left margin. */
function listRows(b: MdBlock, W: number, base = ""): string[] {
	const p = palette();
	const g = graphite();
	const out: string[] = [];
	let lead = "";
	let text = "";
	const flush = (): void => {
		if (lead === "") return;
		// the HANGING INDENT: the continuation prefix is the marker's own
		// visible width, so a wrapped item's later rows align to the text
		// column instead of returning to the margin.
		const body = base === "" ? inlineSpans(text, "") : `${base}${inlineSpans(text, base)}${p.reset}`;
		out.push(...wrap(body, W, lead, " ".repeat(visibleWidth(lead))));
	};
	for (const line of b.lines) {
		const m = ITEM.exec(line);
		if (m === null) {
			text += ` ${line.trim()}`; // an indented continuation of the item
			continue;
		}
		flush();
		const depth = Math.min(5, Math.floor(m[1]!.length / 2));
		// E1: normalization stays — `-`, `*` and `+` all render as ONE
		// marker, so the model's arbitrary choice never leaks onto the
		// screen — but the marker is `- ` rather than `•`, so a copied list
		// is still a list. A numbered list KEEPS its numbers (they are the
		// author's meaning, not decoration).
		const indent = "  ".repeat(depth + 1);
		if (g) {
			// Graphite §5 (R2b) — DECLARED REVERSAL of E1's `- ` (kept so a
			// copied list would still be a list): `–` at the top level and
			// `·` below it, in `dim`, as the prototype draws them; an ordered
			// list keeps its numbers, dim; a task is `✓` (ok) or `○` (dim)
			// in place of the bullet.
			const task = /^\[([ xX])\] +(.*)$/.exec(m[3]!);
			if (task !== null && !/^\d/.test(m[2]!)) {
				const done = task[1] !== " ";
				lead = `${indent}${done ? p.ok : p.dim}${done ? "\u2713" : "\u25cb"}${done ? p.fgEnd : p.reset} `;
				text = task[2]!;
				continue;
			}
			lead = `${indent}${p.dim}${/^\d/.test(m[2]!) ? m[2] : depth === 0 ? "\u2013" : "\u00b7"}${p.reset} `;
			text = m[3]!;
			continue;
		}
		const marker = /^\d/.test(m[2]!) ? `${m[2]} ` : "- ";
		lead = `${indent}${marker}`;
		text = m[3]!;
	}
	flush();
	return out.length > 0 ? out : [""];
}

/**
 * The quote. Its content is BLOCKS, and it is rendered as blocks: the `> `
 * markers come off, the stripped text goes through a NESTED stream — a
 * local, built per render, so `renderBlock` stays pure in (block, W) — and
 * every row it produces takes the `│ ` gutter.
 *
 * R2: one gutter glyph. A quote and a fenced block both say "this text is
 * not mine", and the screen was saying it two ways — ▏ here and │ for code.
 * The fences took their own ``` rails, so │ is free and the quote takes it.
 *
 * MD-1.5 — joining the quote's lines with spaces made a quoted list and a
 * quoted second paragraph into one reflowed line, which is the same class
 * of defect as MD-1.4's: the structure the model sent was destroyed, not
 * merely unstyled.
 *
 * MD-1.5's judgement call: the blanket `dim` over the whole quote is GONE
 * and the gutter carries "not mine" alone. With inner blocks the blanket
 * dim would put dim OVER bold in a quoted heading, which is a
 * contradiction, and over a fence body's inset in a quoted fence. It is
 * also MD-1.2's argument one item earlier: `dim` is a LABEL tier and a
 * quote is body text. The gutter stays dim, because a gutter IS a label.
 */
function quoteRows(b: MdBlock, W: number, depth: number): string[] {
	const p = palette();
	const lines = b.lines.map((l) => QUOTE.exec(l)?.[1] ?? l);
	// Graphite §5 (R2b): a GitHub alert — `> [!NOTE]` on the quote's first
	// line — is a quote with a coloured bar and its kind as a label
	const alert = ALERT.exec(lines[0] ?? "");
	const kind = alert === null ? null : (alert[1]!.toUpperCase() as keyof typeof ALERTS);
	const text = (kind === null ? lines : lines.slice(1)).join("\n");
	// Graphite §5 (R2b): the bar is one cell of BACKGROUND down every row
	// (§1.5 — a glyph bar seams between rows in Apple Terminal), then a
	// space; where there is no background to paint, the `│` gutter stays
	const tone = kind === null ? p.quoteBar : ALERTS[kind].bar(p);
	const painted = tone !== "";
	const gutter = painted ? `${tone} ${p.washEnd} ` : `${p.dim}\u2502${p.reset} `;
	const bar = painted ? `${tone} ${p.washEnd}` : `${p.dim}\u2502${p.reset}`;
	const room = Math.max(1, W - visibleWidth(gutter));
	// a plain quote's words are italic `ink2` (the prototype's); an alert's
	// are the answer's own
	const base = kind === null && graphite() ? `${p.italic}${p.ink2}` : "";
	const label = kind === null ? [] : [`${p.bold}${ALERTS[kind].fg(p)}${ALERTS[kind].word}${p.reset}`];
	if (depth >= QUOTE_DEPTH) return [...label, ...wrap(inlineSpans(text.split("\n").join(" "), ""), room, "", "")].map((r) => `${gutter}${r}`);
	const inner = new MdStream();
	inner.push(text);
	inner.end();
	const rows = [...label, ...inner.blocks().flatMap((blk) => withGap(blk, blockBody(blk, room, depth + 1, base)))];
	// a blank row inside a quote takes the bar and no trailing space: the
	// gutter says "still the quote", the space would be whitespace a human
	// copies for nothing.
	return rows.map((r) => (r === "" ? bar : `${gutter}${r}`));
}

/** GitHub's alert marker: the quote's first line, alone. */
const ALERT = /^\[!(note|tip|important|warning|caution)\]\s*$/i;
/** Each alert's word, its label colour and its bar (Graphite §5, R2b):
 *  the three that inform in `blue`, WARNING in gold, CAUTION in the
 *  failure colour. Off a known ground the label is bold and the bar the
 *  plain gutter. */
const ALERTS = {
	NOTE: { word: "Note", fg: (p: ReturnType<typeof palette>) => p.blue, bar: (p: ReturnType<typeof palette>) => p.noteBar },
	TIP: { word: "Tip", fg: (p: ReturnType<typeof palette>) => p.blue, bar: (p: ReturnType<typeof palette>) => p.noteBar },
	IMPORTANT: { word: "Important", fg: (p: ReturnType<typeof palette>) => p.blue, bar: (p: ReturnType<typeof palette>) => p.noteBar },
	WARNING: { word: "Warning", fg: (p: ReturnType<typeof palette>) => p.goldMark, bar: (p: ReturnType<typeof palette>) => p.warnBar },
	CAUTION: { word: "Caution", fg: (p: ReturnType<typeof palette>) => p.fail, bar: (p: ReturnType<typeof palette>) => p.cautionBar },
} as const;

/**
 * The table. Columns are measured at their NATURAL widths, on the
 * inline-rendered text with the SGR stripped (a bold cell is four
 * columns, not twelve). If the natural widths fit, the table is drawn at
 * them; if they do not, the columns SHRINK and the cells wrap inside
 * them (MD-1.1); only when every column has reached its floor and the
 * table still does not fit does every row become a record. It never
 * cuts, at any width, in any form.
 *
 * A rejected shape (no delimiter row, or a body row wider than the
 * header) falls back to its own source lines, which are still valid
 * markdown. That is the honest exit: a guess about where the extra
 * content belongs would be indistinguishable, once committed, from a
 * fact.
 */
function tableRows(b: MdBlock, W: number): string[] {
	const t = tableShape(b.lines);
	if (t === null) return b.lines.flatMap((l) => wrap(l, W, "", ""));
	const natural = t.header.map((h, i) => Math.max(cellWidth(h), ...t.rows.map((r) => cellWidth(r[i] ?? ""))));
	const cols = shrinkCols(natural, W);
	if (cols === null) return recordRows(t, W);
	const p = palette();
	// DECLARED REVERSAL (2026-09-17), TABLES ONLY. R2 removed the rails at
	// the nineteen-screen review and MD-1.3 put ONE rule under the header;
	// both are superseded here. Every other R2 hairline rule stands, and
	// the record form keeps NO borders — it is the fallback, not a table.
	//
	// The rails are hairlines in the R2 hairline colour, and the styling
	// goes on AFTER the measure, exactly as it does for a cell: a colour
	// can never move a column.
	// Graphite §5 (R2b): the rails in `edge`, lighter than the words
	const [on, off] = p.edge !== "" ? [p.edge, p.fgEnd] : [p.dim, p.reset];
	const rule = (l: string, m: string, r: string): string => `${on}${l}${cols.map((w) => "\u2500".repeat(w + 2)).join(m)}${r}${off}`;
	const V = `${on}\u2502${off}`;
	const row = (cells: readonly string[], bold: boolean): string[] => {
		const boxes = cells.map((c, i) => cellBox(c, cols[i]!, t.align[i]!, bold));
		const rows: string[] = [];
		for (let k = 0; k < Math.max(...boxes.map((x) => x.length)); k += 1) {
			// a short box pays its blanks so the columns to its right do not
			// move: a cell is a BOX, and the row is as tall as its tallest.
			// Trailing space is NOT stripped any more — it sits inside the
			// closing rail, and stripping it would pull the rail left.
			rows.push(`${V}${boxes.map((x, i) => ` ${x[k] ?? " ".repeat(cols[i]!)} `).join(V)}${V}`);
		}
		return rows;
	};
	const body = t.rows.flatMap((r, i) => (i === 0 ? row(r, false) : [rule("\u251c", "\u253c", "\u2524"), ...row(r, false)]));
	return [
		rule("\u250c", "\u252c", "\u2510"),
		...row(t.header, true),
		rule("\u251c", "\u253c", "\u2524"),
		...body,
		rule("\u2514", "\u2534", "\u2518"),
	];
}

/** A cell's column count: what a human sees, styling removed. */
function cellWidth(cell: string): number {
	// R2f: a `<br>` makes a cell several rows — its width is the widest
	return Math.max(0, ...inlineSpans(cell, "").split("\n").map(visibleWidth));
}

/** MD-1.1 — the SHRINK FLOOR: eight columns, four CJK characters. A
 *  column whose natural width is already at or below it never shrinks at
 *  all. The 8 is a judgement and not a measurement — it is where the
 *  report's sample stopped reading as a table — and it is the one number
 *  that decides when the record form is still the better answer. */
const CELL_FLOOR = 8;

/** The drawn width of a grid with these columns.
 *
 *  DECLARED REVERSAL (2026-09-17, tables only): the R2 measure was the
 *  two-column inset plus every column and its two-space gutter — the
 *  shape of a table with NO RAILS. With rails it is `sum + 3n + 1`: one
 *  rail between every pair of columns and one at each edge (n+1), and one
 *  space of padding inside every rail (2n).
 *
 *  This function's old comment said the record threshold "has always been
 *  stated in it", and that is exactly why changing it IS the re-cut: the
 *  grid costs n−1 columns more than the railless form — 2 for a
 *  three-column table, 6 for a seven-column one — and the record fallback
 *  arrives that much earlier. Nothing else moves: the greedy shrink, the
 *  CELL_FLOOR of 8 and the fallback criterion are untouched. */
function gridWidth(cols: readonly number[]): number {
	return cols.reduce((n, w) => n + w, 0) + 3 * cols.length + 1;
}

/**
 * MD-1.1 — take one column off the WIDEST column until the grid fits.
 * Returns null when every column has reached its floor and it still does
 * not, which is the one case the record form exists for.
 *
 * There was no shrink step at all before this: a table either fitted at
 * its natural width or the whole block was abandoned. That made the
 * degradation a cliff — the owner's 6-column sample missed the grid by 8
 * columns at terminal 80 and collapsed into eleven rows of records, when
 * the two columns carrying long CJK phrases would each have wrapped
 * inside their cell for free.
 *
 * Greedy, and therefore PREDICTABLE rather than optimal: always the
 * widest column, ties to the left. A column holding one long unbreakable
 * token will spend its way to the floor and force its neighbours
 * narrower — the cost of a rule a human can hold in their head.
 */
function shrinkCols(natural: readonly number[], W: number): number[] | null {
	const floor = natural.map((w) => Math.min(w, CELL_FLOOR));
	const cols = [...natural];
	while (gridWidth(cols) > W) {
		let at = -1;
		for (let i = 0; i < cols.length; i += 1) if (cols[i]! > floor[i]! && (at < 0 || cols[i]! > cols[at]!)) at = i;
		if (at < 0) return null;
		cols[at] = cols[at]! - 1;
	}
	return cols;
}

/** One cell as a BOX: its text wrapped inside the column, every row
 *  padded to the column's width by the column's alignment. The styling
 *  goes on AFTER the measure, so it can never move a column, and the
 *  wrapper is the same one every other block folds through — so a cell
 *  obeys the kinsoku set and the width authority like all other text. */
function cellBox(cell: string, w: number, align: MdAlign, bold: boolean): string[] {
	const p = palette();
	const body = bold ? `${p.bold}${inlineSpans(cell, p.bold)}${p.reset}` : inlineSpans(cell, "");
	return mdWrap(body, w, "", "").map((r) => {
		const slack = Math.max(0, w - visibleWidth(r));
		const left = align === "right" ? slack : align === "center" ? Math.floor(slack / 2) : 0;
		return `${" ".repeat(left)}${r}${" ".repeat(slack - left)}`;
	});
}

/**
 * The narrow degradation: one record per row. The first column names the
 * record (bold, with a dim colon); the rest is a `label: value` run
 * joined by `·`, wrapped rather than cut. A blank row separates records —
 * nothing is dropped at any width.
 *
 * MD-1.2 — the LABEL is dim and the VALUE is not. This used to wrap every
 * label AND every value in ONE `p.dim` span, so a table's actual content
 * arrived at the lowest contrast tier on the screen while the labels —
 * scaffolding the reader already read in the header row — carried equal
 * weight. The emphasis was exactly inverted.
 *
 * Per-token contrast was never the defect: `dim` measures 4.54:1 on a
 * resolved light ground, which is legal for a LABEL. Setting a whole
 * paragraph of body text in it is a different thing, and on a terminal
 * that never answered OSC 11 it is worse — the palette keeps SGR 2 there
 * rather than an absolute grey. `dim` is a label tier; this is the first
 * place it was asked to be a body tier, and it is no longer asked.
 */
function recordRows(t: MdTable, W: number): string[] {
	const p = palette();
	const out: string[] = [];
	for (const r of t.rows) {
		if (out.length > 0) out.push("");
		out.push(...wrap(`${p.bold}${inlineSpans(t.header[0] ?? "", p.bold)}${p.reset}${p.dim}:${p.reset} ${inlineSpans(r[0] ?? "", "")}`, W, "", ""));
		const rest = t.header.slice(1).map((h, i) => `${p.dim}${inlineSpans(h, p.dim)}:${p.reset} ${inlineSpans(r[i + 1] ?? "", "")}`);
		// the `·` stays dim: it is punctuation between pairs, not content.
		if (rest.length > 0) out.push(...wrap(rest.join(`${p.dim} · ${p.reset}`), W, "", ""));
	}
	return out.length > 0 ? out : [row0(t)];
}

/** A table with a header and no body rows yet (the streaming case):
 *  the header alone, so the block still says what it is. */
function row0(t: MdTable): string {
	const p = palette();
	return `${p.bold}${t.header.join(" · ")}${p.reset}`;
}

// ---- the wrapper ----------------------------------------------------

const SGR_AT = /^\x1b\[[0-9;]*m/;

/** CJK closing punctuation — may not OPEN a row (a line that begins
 *  with a comma reads as broken). The smallest honest kinsoku set. */
const NO_START = "、。，．：；？！）」』】〕·…”’";
/** CJK opening punctuation — may not END one. */
const NO_END = "（「『【〔“‘";

interface Tok {
	readonly text: string;
	readonly w: number;
	readonly space: boolean;
	/** R2f: a forced break (a `<br>`) — the row ends here */
	readonly hard?: true;
}

/** May a row break between `prev` and `ch`? Only where a script allows
 *  it — and never so that a closing mark opens a row or an opening mark
 *  ends one. */
function breaks(prev: string, ch: string): boolean {
	if (NO_START.includes(ch) || NO_END.includes(prev)) return false;
	return breakable(ch.codePointAt(0)!) || breakable(prev.codePointAt(0)!);
}

/** Split styled text into break-eligible tokens. SGR sequences are
 *  zero-width and ride the token they precede; spaces are their own
 *  tokens (they vanish at a break); a CJK character is its own token,
 *  which is the whole fix — a space-free run stops being one word. */
function tokens(text: string): Tok[] {
	const out: Tok[] = [];
	let cur = "";
	let w = 0;
	let prev = "";
	const flush = (): void => {
		if (cur === "") return;
		out.push({ text: cur, w, space: false });
		cur = "";
		w = 0;
	};
	for (let i = 0; i < text.length; ) {
		const m = SGR_AT.exec(text.slice(i));
		if (m !== null) {
			cur += m[0];
			i += m[0].length;
			continue;
		}
		// code POINT stepping — a surrogate pair is one character and can
		// never be cut in half (the halves would measure one column each
		// while the terminal draws two replacement glyphs)
		const cp = text.codePointAt(i)!;
		const ch = String.fromCodePoint(cp);
		i += ch.length;
		if (ch === "\n") {
			flush();
			out.push({ text: "", w: 0, space: false, hard: true });
			prev = "";
			continue;
		}
		if (ch === " " || ch === "\t") {
			flush();
			out.push({ text: " ", w: 1, space: true });
			prev = ch;
			continue;
		}
		// MD1-F1: a `cur` holding nothing but SGR is ZERO-WIDTH and RIDES the
		// token it precedes — this function's own contract, which the flush
		// below used to break. Emitted as a token of its own it measures 0, so
		// `w + pendW + 0 > room` can take a break AT it: the pending space is
		// dropped, the style lands at the head of the next row, and the word it
		// belonged to goes to the row after. Invisible while every style
		// boundary sat at a space (every ASCII case), reachable the moment one
		// sits before a CJK character, which MD-1.2's per-label dim made
		// common in the record form. What it costs there is a trailing space
		// and an empty style span; what it does NOT cause is FINDING MD1-F3
		// below, which is older than this and survives the guard.
		if (cur !== "" && w > 0 && prev !== "" && breaks(prev, ch)) flush();
		cur += ch;
		w += charWidth(cp);
		prev = ch;
	}
	flush();
	return out;
}

/** The SGR spans still open after `text`, given those open before it. */
function opensAfter(text: string, before: readonly string[]): string[] {
	let open = [...before];
	for (const m of text.matchAll(/\x1b\[[0-9;]*m/g)) {
		if (m[0] === "\x1b[0m") open = [];
		else if (m[0] === "\x1b[23m") open = open.filter((s) => s !== "\x1b[3m");
		else open.push(m[0]);
	}
	return open;
}

/** Break one over-wide token by code point — a long identifier or URL
 *  that cannot fit a whole row. Never a truncation: every piece is
 *  emitted. */
function pieces(text: string, room: number): string[] {
	const out: string[] = [];
	let cur = "";
	let w = 0;
	for (let i = 0; i < text.length; ) {
		const m = SGR_AT.exec(text.slice(i));
		if (m !== null) {
			cur += m[0];
			i += m[0].length;
			continue;
		}
		const cp = text.codePointAt(i)!;
		const ch = String.fromCodePoint(cp);
		const cw = charWidth(cp);
		if (w + cw > room && w > 0) {
			out.push(cur);
			cur = "";
			w = 0;
		}
		cur += ch;
		w += cw;
		i += ch.length;
	}
	if (cur !== "") out.push(cur);
	return out;
}

/**
 * Wrap styled text into rows of at most W columns, with a HANGING
 * INDENT: `first` prefixes the first row, `hang` every later one, and
 * the text column is what continuations align to.
 *
 * The SGR spans open at a break are closed at the row's end and
 * reopened at the next row's start, so no style leaks into the padding
 * and none is lost across the break. Italic's own close (23) is
 * understood, so `\x1b[3m…\x1b[23m` inside a bold heading tracks
 * correctly.
 *
 * Every emitted row measures ≤ W through the SAME width authority the
 * compositor's invariant ① measures with — which is the only way the
 * two can agree.
 */
export function mdWrap(text: string, W: number, first: string, hang: string): string[] {
	const rows: string[] = [];
	// a degenerate geometry (a deeply nested marker in a very narrow
	// terminal) can make the PREFIX itself wider than the row. The prefix
	// is chrome we generate, so it yields: it is cut to leave room for one
	// WIDE character (two columns — a row that cannot hold one CJK glyph
	// cannot hold the content it exists for), and the invariant holds
	// instead of throwing on our own decoration.
	const fit = (s: string): string => (visibleWidth(s) <= W - 2 ? s : (pieces(s, Math.max(0, W - 2))[0] ?? ""));
	let prefix = fit(first);
	let room = Math.max(1, W - visibleWidth(prefix));
	let line = "";
	let w = 0;
	let open: string[] = [];
	let pend = "";
	let pendW = 0;
	const close = (): void => {
		rows.push(`${prefix}${line}${open.length > 0 ? "\x1b[0m" : ""}`);
		prefix = fit(hang);
		room = Math.max(1, W - visibleWidth(prefix));
		line = open.join("");
		w = 0;
		pend = "";
		pendW = 0;
	};
	for (const t of tokens(text)) {
		if (t.hard === true) {
			close();
			continue;
		}
		if (t.space) {
			// a space at a break vanishes; inside a row it is held until the
			// next word earns it
			if (w > 0) {
				pend += t.text;
				pendW += t.w;
			}
			continue;
		}
		if (w > 0 && w + pendW + t.w > room) close();
		if (t.w > room) {
			// too wide for any row: break it by code point, each piece its own
			// row except the last, which carries on
			const parts = pieces(t.text, room);
			for (let k = 0; k < parts.length; k += 1) {
				if (k > 0) close();
				line += parts[k];
				w += k === parts.length - 1 ? visibleWidth(parts[k]!) : room;
				open = opensAfter(parts[k]!, open);
			}
			continue;
		}
		line += pend + t.text;
		w += pendW + t.w;
		open = opensAfter(pend + t.text, open);
		pend = "";
		pendW = 0;
	}
	rows.push(`${prefix}${line}${open.length > 0 ? "\x1b[0m" : ""}`);
	return rows;
}


/** The block-level entry: wrap `text` under a first/hang prefix pair. */
function wrap(text: string, W: number, first: string, hang: string): string[] {
	return mdWrap(text, W, first, hang);
}

/** A fence body line: code, not prose — it still wraps rather than
 *  truncating (the no-silent-truncate ruling), every row carries the
 *  gutter, and the source line's own indent prefixes every row. */
function foldLineWidth(line: string, W: number, indent = ""): string[] {
	return mdWrap(line, Math.max(1, W), indent, indent);
}
