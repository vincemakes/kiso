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

import { palette } from "./render.js";
import { breakable, charWidth, displayWidth } from "./width.js";
import { escapeTerminal } from "./render.js";
import { visibleWidth } from "./components.js";

/** The block kinds. `fence-open`/`fence-line` are separate kinds on
 *  purpose: a fence's rows must be able to freeze ONE AT A TIME. */
export type MdKind = "para" | "heading" | "list" | "table" | "quote" | "rule" | "fence-open" | "fence-line" | "fence-close";

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
const ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;

/** The kind a line would START. null = blank (a block separator). */
function classify(line: string): MdKind | null {
	if (line.trim() === "") return null;
	if (FENCE.test(line)) return "fence-open";
	if (RULE.test(line)) return "rule";
	if (HEADING.test(line)) return "heading";
	if (QUOTE.test(line)) return "quote";
	if (TABLE.test(line)) return "table";
	if (ITEM.test(line)) return "list";
	return "para";
}

/** Can `line` JOIN an open block of this kind? Headings, rules and the
 *  fence rows are single-line blocks and never take a second line. */
function joins(kind: MdKind, line: string): boolean {
	const c = classify(line);
	if (c === null) return false; // a blank closes everything
	switch (kind) {
		case "para":
			return c === "para";
		case "list":
			// a list item's continuation must be INDENTED — an unindented
			// paragraph after a list starts a paragraph (the lazy-continuation
			// rule is a documented deviation: predictable beats compliant when
			// the output is committed).
			return c === "list" || (c === "para" && /^[ \t]/.test(line));
		case "table":
			return c === "table";
		case "quote":
			return c === "quote";
		default:
			return false;
	}
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
		const k = classify(p);
		if (k !== null) out.push({ kind: k, lines: [p], gap: this.#started > 0, lang: k === "fence-open" ? fenceLang(p) : "" });
		return out;
	}

	/** How many leading blocks are CLOSED — the commit-eligible count. */
	closed(): number {
		return this.#closed.length;
	}

	#line(line: string): void {
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
		const k = classify(line);
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
		this.#open = { kind: k, lines: [line], gap: this.#started > 0, lang: "" };
		this.#started += 1;
	}

	/** A block that is final the moment its line is. */
	#push(b: MdBlock): void {
		this.#closed.push(b);
		this.#started += 1;
	}

	#shut(): void {
		if (this.#open === null) return;
		this.#closed.push(frozen(this.#open));
		this.#open = null;
	}
}

function fenceLang(line: string): string {
	return (FENCE.exec(line)?.[2] ?? "").trim();
}

// ---- rendering ------------------------------------------------------

/** The whole message at once — the freeze property's oracle, and the
 *  path a non-streaming caller takes. */
export function renderMarkdown(text: string, W: number): string[] {
	const s = new MdStream();
	s.push(text);
	s.end();
	return s.blocks().flatMap((b) => renderBlock(b, W));
}

/** One block's screen rows. Pure in (block, W) — this is the whole
 *  freeze guarantee: same source, same width, same bytes, forever. */
export function renderBlock(b: MdBlock, W: number): string[] {
	const rows = blockBody(b, Math.max(1, W));
	return b.gap ? ["", ...rows] : rows;
}

function blockBody(b: MdBlock, W: number): string[] {
	const p = palette();
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
			const m = HEADING.exec(b.lines[0] ?? "");
			const level = (m?.[1] ?? "#").length;
			const text = m?.[2] ?? b.lines[0] ?? "";
			const style = level === 1 ? `${p.bold}${p.underline}` : p.bold;
			const marker = level >= 3 ? `${"#".repeat(level)} ` : "";
			return wrap(`${style}${marker}${inlineSpans(text, style)}${p.reset}`, W, "", "");
		}
		case "rule":
			// R2: the dashed rule, at the block's own width. The 28 was a
			// guess that read as a short line rather than a divider, and ─
			// belonged to the box vocabulary this round is collapsing.
			return [`${p.dim}${"\u254c".repeat(Math.max(1, W))}${p.reset}`];
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
		case "fence-line": {
			// a fence body's INDENTATION is its content. The wrapper drops
			// leading spaces \u2014 right for prose, a lie for code \u2014 so the indent
			// rides as the row prefix instead, and a wrapped long line hangs
			// under it rather than returning to the gutter.
			const src = (b.lines[0] ?? "").replace(/\t/g, "    ");
			const indent = /^ */.exec(src)![0];
			const gutter = "  "; // E2: the rails bound the block; the body just insets
			// DC-3: a fenced BODY carries no colour token. It used to take
			// `code` — 1.54:1 on a white terminal, applied to whole blocks,
			// which made the code the model just wrote the least readable
			// thing on screen. The `│` gutter already says "this block is
			// verbatim"; saying it twice cost legibility and bought nothing.
			return foldLineWidth(src.slice(indent.length), W - visibleWidth(gutter), indent).map((r) => `${gutter}${r}`);
		}
		case "quote": {
			const text = b.lines.map((l) => QUOTE.exec(l)?.[1] ?? l).join(" ");
			// R2: one gutter glyph. A quote and a fenced block both say "this
			// text is not mine", and the screen was saying it two ways — ▏
			// here and │ for code. The fences took their own ``` rails, so │
			// is free and the quote takes it.
			const gutter = `${p.dim}\u2502${p.reset} `;
			return wrap(`${p.dim}${inlineSpans(text, p.dim)}${p.reset}`, W - visibleWidth(gutter), "", "").map((r) => `${gutter}${r}`);
		}
		case "list":
			return listRows(b, W);
		case "table":
			return tableRows(b, W);
		default:
			// a paragraph's soft line breaks are spaces — the block reflows at
			// the terminal's width, which is the whole point of rendering it.
			return wrap(inlineSpans(b.lines.join(" "), ""), W, "", "");
	}
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
 * Documented deviations from CommonMark: `_` never emphasizes (it is a
 * character in identifiers far more often than a marker in prose);
 * emphasis does not nest across a code span; `~~` is not a construct at
 * all — the markers are content (the strict tokenizer both reference
 * implementations converged on, taken to its honest conclusion, since
 * SGR 9's terminal support is too fragmented to promise).
 */
export function inlineSpans(text: string, base: string): string {
	const p = palette();
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
			const end = text.indexOf("`", i + 1);
			if (end > i) {
				// a code span's content is LITERAL — no markers inside it mean
				// anything, which is what makes `x | y` survive a table split
				// DC-3: inline code is a SURFACE (`wash`), closed with washEnd
				// rather than a reset so the span composes inside a heading's
				// or a quote's own style.
				out += `${p.wash}${text.slice(i + 1, end)}${p.washEnd}${base}`;
				i = end + 1;
				continue;
			}
		}
		if (text.startsWith("**", i)) {
			const end = closerAt(text, i + 2, "**");
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
		if (ch === "[") {
			const link = LINK.exec(text.slice(i));
			if (link !== null) {
				// the text bright, the url dim in parentheses. NO OSC 8 this
				// round: a hyperlink escape is bytes the human cannot see, and
				// the byte discipline gets to decide that separately.
				out += `${p.bold}${link[1]}${p.reset}${p.dim} (${link[2]})${p.reset}${base}`;
				i += link[0].length;
				continue;
			}
		}
		out += ch;
		i += 1;
	}
	return out;
}

const ESCAPABLE = /[\\`*_~[\]()#|+.!>-]/;
const LINK = /^\[([^\]\n]*)\]\(([^)\s\n]*)\)/;

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
function listRows(b: MdBlock, W: number): string[] {
	const p = palette();
	const out: string[] = [];
	let lead = "";
	let text = "";
	const flush = (): void => {
		if (lead === "") return;
		// the HANGING INDENT: the continuation prefix is the marker's own
		// visible width, so a wrapped item's later rows align to the text
		// column instead of returning to the margin.
		out.push(...wrap(inlineSpans(text, ""), W, lead, " ".repeat(displayWidth(lead))));
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
		const marker = /^\d/.test(m[2]!) ? `${m[2]} ` : "- ";
		lead = `${"  ".repeat(depth + 1)}${marker}`;
		text = m[3]!;
	}
	flush();
	return out.length > 0 ? out : [""];
}

/**
 * The table. Columns are measured at their NATURAL widths, on the
 * inline-rendered text with the SGR stripped (a bold cell is four
 * columns, not twelve). If the whole table fits, it is drawn aligned
 * with the dim rails; if it does not, it does NOT shrink and it does
 * NOT cut — every row becomes a record, and every cell survives.
 *
 * A rejected shape (no delimiter row, or a body row wider than the
 * header) falls back to its own source lines, which are still valid
 * markdown. That is the honest exit: a guess about where the extra
 * content belongs would be indistinguishable, once committed, from a
 * fact.
 */
function tableRows(b: MdBlock, W: number): string[] {
	const p = palette();
	const t = tableShape(b.lines);
	if (t === null) return b.lines.flatMap((l) => wrap(l, W, "", ""));
	const cols = t.header.map((h, i) => Math.max(cellWidth(h), ...t.rows.map((r) => cellWidth(r[i] ?? ""))));
	// R2: no rails. The drawn width is two columns of inset plus the
	// columns and their two-space gutters — a table is bounded by the
	// blank lines above and below it, exactly as every other block on the
	// screen is, and it was the last box left on a screen that has decided
	// not to have boxes. Alignment does the work the rails were doing, and
	// a copied table is closer to markdown without them.
	const total = cols.reduce((n, w) => n + w + 2, 2);
	if (total > W) return recordRows(t, W);
	const row = (cells: readonly string[], bold: boolean): string =>
		`  ${cells.map((c, i) => pad(c, cols[i]!, t.align[i]!, bold)).join("  ")}`.replace(/\s+$/, "");
	return [row(t.header, true), ...t.rows.map((r) => row(r, false))];
}

/** A cell's column count: what a human sees, styling removed. */
function cellWidth(cell: string): number {
	return visibleWidth(inlineSpans(cell, ""));
}

/** One padded cell — the styling goes on AFTER the measure, so it can
 *  never move a column. */
function pad(cell: string, w: number, align: MdAlign, bold: boolean): string {
	const p = palette();
	const body = bold ? `${p.bold}${inlineSpans(cell, p.bold)}${p.reset}` : inlineSpans(cell, "");
	const slack = Math.max(0, w - cellWidth(cell));
	const left = align === "right" ? slack : align === "center" ? Math.floor(slack / 2) : 0;
	return `${" ".repeat(left)}${body}${" ".repeat(slack - left)}`;
}

/** The narrow degradation: one record per row. The first column names
 *  the record (bold, with a dim colon); the rest is a dim `label:
 *  value` run joined by `·`, wrapped rather than cut. A blank row
 *  separates records — nothing is dropped at any width. */
function recordRows(t: MdTable, W: number): string[] {
	const p = palette();
	const out: string[] = [];
	for (const r of t.rows) {
		if (out.length > 0) out.push("");
		out.push(...wrap(`${p.bold}${inlineSpans(t.header[0] ?? "", p.bold)}${p.reset}${p.dim}:${p.reset} ${inlineSpans(r[0] ?? "", "")}`, W, "", ""));
		const rest = t.header.slice(1).map((h, i) => `${h}: ${r[i + 1] ?? ""}`);
		if (rest.length > 0) out.push(...wrap(`${p.dim}${inlineSpans(rest.join(" · "), p.dim)}${p.reset}`, W, "", ""));
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
		if (ch === " " || ch === "\t") {
			flush();
			out.push({ text: " ", w: 1, space: true });
			prev = ch;
			continue;
		}
		if (cur !== "" && prev !== "" && breaks(prev, ch)) flush();
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
