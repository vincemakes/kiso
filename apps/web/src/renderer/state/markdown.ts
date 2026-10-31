/**
 * The answer's markdown, small on purpose: headings, paragraphs, lists,
 * fenced code, and inline bold, italic, code and link text. It produces a
 * tree (no HTML strings, so nothing the model writes becomes markup) that
 * the Answer component draws.
 *
 * While the answer streams, `holdBack` withholds what is not yet a whole
 * construct: an unclosed `**` or backtick and everything after it, so the
 * reader never sees stray markers flash in and out.
 */

export type Inline =
	| { readonly t: "text"; readonly text: string }
	| { readonly t: "b" | "i"; readonly children: readonly Inline[] }
	| { readonly t: "code"; readonly text: string }
	| { readonly t: "link"; readonly text: string; readonly href: string };

export type Block =
	| { readonly t: "h"; readonly level: 1 | 2 | 3; readonly inline: readonly Inline[] }
	| { readonly t: "p"; readonly inline: readonly Inline[] }
	| { readonly t: "ul" | "ol"; readonly items: readonly (readonly Inline[])[] }
	| { readonly t: "code"; readonly lang: string; readonly text: string };

const FENCE = /^```(\S*)\s*$/;

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
	// a lone trailing "*" may be the start of "**"
	if (cut === raw.length && outside.endsWith("*") && !outside.endsWith("**")) cut = raw.length - 1;
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
		if ((m = /^`([^`]+)`/.exec(rest)) !== null) {
			flush();
			out.push({ t: "code", text: m[1]! });
			i += m[0].length;
		} else if ((m = /^\*\*(.+?)\*\*/s.exec(rest)) !== null) {
			flush();
			out.push({ t: "b", children: inline(m[1]!) });
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
