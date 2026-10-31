/**
 * The answer's markdown, small on purpose: headings, paragraphs, lists,
 * fenced code, GFM tables, blockquotes, horizontal rules, and inline bold,
 * italic, strikethrough, code and link text. It produces a tree (no HTML
 * strings, so nothing the model writes becomes markup) that the Answer
 * component draws.
 *
 * While the answer streams, `holdBack` withholds what is not yet a whole
 * construct: an unclosed `**`, `~~` or backtick and everything after it, and
 * a table row still being written, so the reader never sees stray markers
 * flash in and out.
 */

export type Inline =
	| { readonly t: "text"; readonly text: string }
	| { readonly t: "b" | "i" | "s"; readonly children: readonly Inline[] }
	| { readonly t: "code"; readonly text: string }
	| { readonly t: "link"; readonly text: string; readonly href: string };

export type Block =
	| { readonly t: "h"; readonly level: 1 | 2 | 3; readonly inline: readonly Inline[] }
	| { readonly t: "p"; readonly inline: readonly Inline[] }
	| { readonly t: "ul" | "ol"; readonly items: readonly (readonly Inline[])[] }
	| { readonly t: "code"; readonly lang: string; readonly text: string }
	| { readonly t: "table"; readonly align: readonly Align[]; readonly head: readonly (readonly Inline[])[]; readonly rows: readonly (readonly (readonly Inline[])[])[] }
	| { readonly t: "quote"; readonly children: readonly Block[] }
	| { readonly t: "hr" };

export type Align = "left" | "center" | "right" | null;

const FENCE = /^```(\S*)\s*$/;
const HR = /^ {0,3}([-*_])( *\1){2,} *$/;
const DELIM_CELL = /^:?-+:?$/;
/** a `|` that is not escaped */
const PIPE = /(?<!\\)\|/;
const endsWithPipe = (line: string): boolean => /(?<!\\)\|\s*$/.test(line);

/** The cells of a table row: the outer pipes are optional; an escaped `\|`, or a pipe inside inline code, stays in its cell. */
export function cells(line: string): string[] {
	let row = line.trim();
	if (row.startsWith("|")) row = row.slice(1);
	if (endsWithPipe(row)) row = row.replace(/\|\s*$/, "");
	const out: string[] = [];
	let cell = "";
	let code = false;
	for (let i = 0; i < row.length; i++) {
		const ch = row[i]!;
		if (ch === "`") code = !code;
		if (ch === "|" && !code && row[i - 1] !== "\\") {
			out.push(cell.trim());
			cell = "";
		} else cell += ch;
	}
	return [...out, cell.trim()];
}

/** A delimiter row (`|---|:--:|`) with as many cells as the header: its alignments, else null. */
function delimiter(line: string, width: number): Align[] | null {
	if (!PIPE.test(line)) return null;
	const parts = cells(line);
	if (parts.length !== width || !parts.every((c) => DELIM_CELL.test(c))) return null;
	return parts.map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
}

/** Split off the part of a still-streaming answer that is not yet whole. */
export function holdBack(raw: string): string {
	// inside an unclosed fence everything is code: nothing is withheld
	const fences = raw.split("\n").filter((l) => FENCE.test(l)).length;
	if (fences % 2 === 1) return raw;
	// markers inside closed fences do not count
	const outside = raw.replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, (m) => " ".repeat(m.length));
	let cut = raw.length;
	if ((outside.match(/`/g) ?? []).length % 2 === 1) cut = Math.min(cut, outside.lastIndexOf("`"));
	if ((outside.match(/\*\*/g) ?? []).length % 2 === 1) cut = Math.min(cut, outside.lastIndexOf("**"));
	if ((outside.match(/~~/g) ?? []).length % 2 === 1) cut = Math.min(cut, outside.lastIndexOf("~~"));
	// a lone trailing "*" or "~" may be the start of "**" or "~~"
	if (cut === raw.length && /(^|[^*])\*$|(^|[^~])~$/.test(outside)) cut = raw.length - 1;
	// a table row still being written (no closing pipe, no newline yet), or a delimiter row under a header: withheld until its line is whole
	const start = outside.lastIndexOf("\n") + 1;
	const last = outside.slice(start);
	const prev = outside.slice(outside.lastIndexOf("\n", start - 2) + 1, Math.max(0, start - 1));
	const inTable = start > 0 && PIPE.test(prev);
	const rowDone = endsWithPipe(last) && last.trim().length > 1 && !(inTable && /^[\s|:-]+$/.test(last));
	if (last.trim() !== "" && (last.trimStart().startsWith("|") || inTable) && (!rowDone || !inTable)) cut = Math.min(cut, start);
	// a line that is only a block marker so far (a list, a quote, a heading) becomes that block once its text starts: shown then, not as a paragraph first
	if (/^\s*([-*+>#|]|\d+[.)]?)\s?$/.test(last)) cut = Math.min(cut, start);
	// a header row is drawn once the line under it says whether it heads a table: never as a paragraph that turns into one
	const kept = outside.slice(0, cut);
	if (kept.endsWith("\n")) {
		const lines = kept.slice(0, -1).split("\n");
		const header = lines.at(-1)!;
		const above = lines.at(-2);
		if (header.trimStart().startsWith("|") && (above === undefined || !PIPE.test(above))) cut = kept.length - header.length - 1;
	}
	return raw.slice(0, cut);
}

export function inline(raw: string): Inline[] {
	const out: Inline[] = [];
	let i = 0;
	let buf = "";
	const flush = (): void => {
		if (buf !== "") out.push({ t: "text", text: buf });
		buf = "";
	};
	while (i < raw.length) {
		const rest = raw.slice(i);
		let m: RegExpExecArray | null;
		if ((m = /^\\([|\\`*_~[\]])/.exec(rest)) !== null) {
			buf += m[1];
			i += 2;
		} else if ((m = /^`([^`]+)`/.exec(rest)) !== null) {
			flush();
			out.push({ t: "code", text: m[1]! });
			i += m[0].length;
		} else if ((m = /^\*\*(.+?)\*\*/s.exec(rest)) !== null) {
			flush();
			out.push({ t: "b", children: inline(m[1]!) });
			i += m[0].length;
		} else if ((m = /^~~(?!\s)(.+?)~~/s.exec(rest)) !== null) {
			flush();
			out.push({ t: "s", children: inline(m[1]!) });
			i += m[0].length;
		} else if ((m = /^\*([^*\s][^*]*?)\*(?!\*)/.exec(rest)) !== null) {
			flush();
			out.push({ t: "i", children: inline(m[1]!) });
			i += m[0].length;
		} else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest)) !== null) {
			flush();
			out.push({ t: "link", text: m[1]!, href: m[2]! });
			i += m[0].length;
		} else {
			buf += raw[i];
			i += 1;
		}
	}
	flush();
	return out;
}

export function parse(raw: string): Block[] {
	const blocks: Block[] = [];
	const lines = raw.split("\n");
	let para: string[] = [];
	const endPara = (): void => {
		if (para.length > 0) blocks.push({ t: "p", inline: inline(para.join(" ")) });
		para = [];
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const fence = FENCE.exec(line);
		if (fence !== null) {
			endPara();
			const body: string[] = [];
			for (i += 1; i < lines.length && !FENCE.test(lines[i]!); i++) body.push(lines[i]!);
			blocks.push({ t: "code", lang: fence[1]!, text: body.join("\n") });
			continue;
		}
		const head = PIPE.test(line) ? cells(line) : null;
		const align = head === null || i + 1 >= lines.length ? null : delimiter(lines[i + 1]!, head.length);
		if (head !== null && align !== null) {
			endPara();
			const rows: Inline[][][] = [];
			for (i += 2; i < lines.length && lines[i]!.trim() !== "" && PIPE.test(lines[i]!); i++) {
				const row = cells(lines[i]!);
				rows.push(head.map((_, c) => inline(row[c] ?? "")));
			}
			i -= 1;
			blocks.push({ t: "table", align, head: head.map((c) => inline(c)), rows });
			continue;
		}
		if (/^ {0,3}>/.test(line)) {
			endPara();
			const body: string[] = [];
			for (; i < lines.length && /^ {0,3}>/.test(lines[i]!); i++) body.push(lines[i]!.replace(/^ {0,3}> ?/, ""));
			i -= 1;
			blocks.push({ t: "quote", children: parse(body.join("\n")) });
			continue;
		}
		if (HR.test(line)) {
			endPara();
			blocks.push({ t: "hr" });
			continue;
		}
		const h = /^(#{1,3})\s+(.*)$/.exec(line);
		if (h !== null) {
			endPara();
			blocks.push({ t: "h", level: h[1]!.length as 1 | 2 | 3, inline: inline(h[2]!) });
			continue;
		}
		const li = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
		if (li !== null) {
			endPara();
			const kind = /\d/.test(li[1]!) ? "ol" : "ul";
			const last = blocks.at(-1);
			const item = inline(li[2]!);
			if (last?.t === kind) (last.items as Inline[][]).push(item);
			else blocks.push({ t: kind, items: [item] });
			continue;
		}
		if (line.trim() === "") endPara();
		else para.push(line.trim());
	}
	endPara();
	return blocks;
}

/** The blocks to draw for an answer that is still arriving (`live`) or whole. */
export const render = (raw: string, live: boolean): Block[] => parse(live ? holdBack(raw) : raw);
