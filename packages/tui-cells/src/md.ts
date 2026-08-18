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
 * The style table is the round's normative one and lives in `style()`.
 */

import { palette } from "./render.js";
import { displayWidth } from "./width.js";
import { escapeTerminal } from "./render.js";
import { foldWords, visibleWidth } from "./components.js";

/** The block kinds. `fence-open`/`fence-line` are separate kinds on
 *  purpose: a fence's rows must be able to freeze ONE AT A TIME. */
export type MdKind = "para" | "heading" | "list" | "table" | "quote" | "rule" | "fence-open" | "fence-line";

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
			// the closer emits no block: a bottom border is drawn only by an
			// actual close, and under committed lines a phantom one would be
			// a lie the force-commit path could freeze.
			if (closesFence(line, this.#fence)) {
				this.#fence = null;
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
			// the marker is stripped, the numbering kept, and the levels are
			// NOT differentiated by colour — attributes only. A `**bold**`
			// inside a heading is therefore a no-op, which is the mono
			// discipline paying for itself: the nested-style restore machinery
			// both reference implementations need for this exact input has
			// nothing to restore here.
			const m = HEADING.exec(b.lines[0] ?? "");
			return wrap(`${p.bold}${inlineSpans(m?.[2] ?? b.lines[0] ?? "", p.bold)}${p.reset}`, W, "", "");
		}
		case "rule":
			return [`${p.dim}${"─".repeat(Math.min(W, 28))}${p.reset}`];
		case "fence-open":
			// the dim gutter names the block; the language tag rides the
			// opening row. Zero highlighting — which is exactly what makes a
			// fence body line committable on its own.
			return [`${p.dim}│${b.lang === "" ? "" : ` ${b.lang}`}${p.reset}`];
		case "fence-line": {
			const gutter = `${p.dim}│${p.reset} `;
			return foldLineWidth(`${p.code}${b.lines[0] ?? ""}${p.reset}`, W - 2).map((r) => `${gutter}${r}`);
		}
		case "quote": {
			const text = b.lines.map((l) => QUOTE.exec(l)?.[1] ?? l).join(" ");
			const gutter = `${p.dim}▏${p.reset} `;
			return wrap(`${p.dim}${inlineSpans(text, p.dim)}${p.reset}`, W - 2, "", "").map((r) => `${gutter}${r}`);
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
				out += `${p.code}${text.slice(i + 1, end)}${p.reset}${base}`;
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
		// `•` normalization for bullets; a numbered list KEEPS its numbers
		// (they are the author's meaning, not decoration).
		const marker = /^\d/.test(m[2]!) ? `${m[2]} ` : "• ";
		lead = `${"  ".repeat(depth + 1)}${marker}`;
		text = m[3]!;
	}
	flush();
	return out.length > 0 ? out : [""];
}

/** Slice ④ owns this. Until then the source lines pass through — the
 *  honest degradation: the bytes stay valid markdown. */
function tableRows(b: MdBlock, W: number): string[] {
	return b.lines.flatMap((l) => wrap(l, W, "", ""));
}

/** Slice ③ owns this: the CJK break class + the width-correct hang.
 *  Until then it is the whitespace-only wrap the tree already had, with
 *  the prefixes bolted on — which is precisely the shape the recon
 *  found overflows on a space-free CJK run. */
function wrap(text: string, W: number, first: string, hang: string): string[] {
	const room = Math.max(1, W - visibleWidth(first));
	return foldWords(text, room).map((r, i) => `${i === 0 ? first : hang}${r}`);
}

/** A hard fold at an exact width (fence bodies: code is not prose). */
function foldLineWidth(line: string, W: number): string[] {
	return foldWords(line, Math.max(1, W));
}

/** The style table, in one place. The round's normative mapping —
 *  headings bold with the marker stripped; bold bright; italic SGR 3;
 *  inline code the existing tint; fences a dim gutter with a dim
 *  language tag and no highlighting; lists `•` with a hanging indent;
 *  tables aligned with dim rules and a bold header; quotes a dim `▏`;
 *  links bright text with a dim `(url)`; rules a dim line; `~~` kept
 *  literal (SGR 9's terminal support is too fragmented to be honest).
 *  Exported so the mapping is testable as data, not by inference. */
export function style(): Record<string, string> {
	const p = palette();
	return { heading: p.bold, bold: p.bold, italic: p.italic, code: p.code, gutter: p.dim, rule: p.dim, quote: p.dim, url: p.dim, reset: p.reset };
}
