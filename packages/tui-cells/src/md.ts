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
			// NOT differentiated by colour — attributes only.
			const m = HEADING.exec(b.lines[0] ?? "");
			return wrap(`${p.bold}${m?.[2] ?? b.lines[0] ?? ""}${p.reset}`, W, "", "");
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
			return wrap(`${p.dim}${text}${p.reset}`, W - 2, "", "").map((r) => `${gutter}${r}`);
		}
		case "list":
			return listRows(b, W);
		case "table":
			return tableRows(b, W);
		default:
			// a paragraph's soft line breaks are spaces — the block reflows at
			// the terminal's width, which is the whole point of rendering it.
			return wrap(inline(b.lines.join(" "), ""), W, "", "");
	}
}

/** Slice ② owns the full mono style table. Slice ① carries the ONE
 *  inline rule the streaming discipline needs: RAW UNTIL CLOSED. An
 *  opener with no closer in this block stays literal — so a half-
 *  streamed `**` shows its asterisks and flips the instant the closer
 *  lands, inside the live block and nowhere else. */
function inline(text: string, base: string): string {
	const p = palette();
	if (p.bold === "") return text;
	let out = "";
	let i = 0;
	while (i < text.length) {
		if (text.startsWith("**", i)) {
			const end = text.indexOf("**", i + 2);
			if (end > i + 2) {
				out += `${p.bold}${text.slice(i + 2, end)}${p.reset}${base}`;
				i = end + 2;
				continue;
			}
		}
		out += text[i];
		i += 1;
	}
	return out;
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
		out.push(...wrap(text, W, lead, " ".repeat(displayWidth(lead))));
	};
	for (const line of b.lines) {
		const m = ITEM.exec(line);
		if (m === null) {
			text += ` ${line.trim()}`; // an indented continuation of the item
			continue;
		}
		flush();
		const depth = Math.min(5, Math.floor(m[1]!.length / 2));
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
	return { heading: p.bold, bold: p.bold, code: p.code, gutter: p.dim, rule: p.dim, quote: p.dim, url: p.dim, reset: p.reset };
}
