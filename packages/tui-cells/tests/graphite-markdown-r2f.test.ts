/**
 * Graphite R2f (owner, 2026-09-30) — the inline constructs the owner's
 * markdown test document showed broken: bold italic, a bold closing an
 * italic inside it, code spans of any backtick run, a link's title,
 * autolinks, images, reference links and their definitions, and `<br>`.
 * Titles and alt texts are written in Chinese as in that document.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MdStream, inlineSpans, renderBlock, renderMarkdown } from "../src/md.js";
import { palette, setGround } from "../src/render.js";
import { visibleWidth } from "../src/components.js";

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const rows = (md: string, W = 80): string[] => renderMarkdown(md, W).map(plain);

beforeEach(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	delete process.env.NO_COLOR;
	setGround("light");
});
afterEach(() => {
	delete (process.stdout as { isTTY?: boolean }).isTTY;
	setGround("unknown");
});

describe("R2f — emphasis", () => {
	it("***x*** is bold and italic, with no asterisk left", () => {
		const p = palette();
		const out = inlineSpans("a ***\u7c97\u659c\u4f53*** b", "");
		expect(plain(out)).toBe("a \u7c97\u659c\u4f53 b");
		expect(out).toContain(`${p.bold}${p.italic}\u7c97\u659c\u4f53${p.italicEnd}${p.reset}`);
	});

	it("a bold closes at the end of its asterisk run, so the italic inside it closes first", () => {
		const p = palette();
		const out = inlineSpans("\u7ec4\u5408\uff1a**\u7c97\u4f53\u91cc\u7684 `\u4ee3\u7801` \u548c *\u659c\u4f53***", "");
		expect(plain(out)).toBe("\u7ec4\u5408\uff1a\u7c97\u4f53\u91cc\u7684 \u4ee3\u7801 \u548c \u659c\u4f53");
		expect(out).toContain(`${p.italic}\u659c\u4f53${p.italicEnd}`);
		// and a plain bold beside an italic is unchanged
		expect(plain(inlineSpans("**a** *b*", ""))).toBe("a b");
	});
});

describe("R2f — code spans", () => {
	it("a run of backticks closes at the next run of the same length, one padding space off each end", () => {
		expect(plain(inlineSpans("\u5199\u6cd5 `` `\u884c\u5185\u4ee3\u7801` `` \u7ed3\u675f", ""))).toBe("\u5199\u6cd5 `\u884c\u5185\u4ee3\u7801` \u7ed3\u675f");
		expect(plain(inlineSpans("``a`b``", ""))).toBe("a`b");
		expect(plain(inlineSpans("run `npm test` now", ""))).toBe("run npm test now");
	});

	it("a run with no closer of its length is literal", () => {
		expect(plain(inlineSpans("`a``", ""))).toBe("`a``");
		expect(plain(inlineSpans("``` not code", ""))).toBe("``` not code");
	});
});

describe("R2f — links, autolinks and images", () => {
	it("a link's title is read and dropped", () => {
		expect(plain(inlineSpans('[\u60ac\u505c\u6709\u63d0\u793a](https://example.com "\u8fd9\u662f title \u5c5e\u6027")', ""))).toBe("\u60ac\u505c\u6709\u63d0\u793a (https://example.com)");
		expect(plain(inlineSpans("[t](https://e.com 'single')", ""))).toBe("t (https://e.com)");
		expect(plain(inlineSpans("[t](https://e.com (paren))", ""))).toBe("t (https://e.com)");
	});

	it("an autolink is the address itself, as a link; anything else in angle brackets stays", () => {
		const p = palette();
		expect(plain(inlineSpans("\u81ea\u52a8\u94fe\u63a5\uff1a<https://github.com/>", ""))).toBe("\u81ea\u52a8\u94fe\u63a5\uff1ahttps://github.com/");
		expect(inlineSpans("<https://github.com/>", "")).toContain(`${p.blue}${p.underline}https://github.com/`);
		expect(plain(inlineSpans("\u88f8\u90ae\u7bb1\uff1a<someone@example.com>", ""))).toBe("\u88f8\u90ae\u7bb1\uff1asomeone@example.com");
		expect(plain(inlineSpans("a < b > c and <div>", ""))).toBe("a < b > c and <div>");
	});

	it("an image is named: `image` dim, the alt as a link, the url dim", () => {
		const p = palette();
		const out = inlineSpans("![\u5360\u4f4d\u56fe](https://via.placeholder.com/120x40 \"\u56fe\u7247\")", "");
		expect(plain(out)).toBe("image \u5360\u4f4d\u56fe (https://via.placeholder.com/120x40)");
		expect(out.startsWith(`${p.dim}image${p.reset}`)).toBe(true);
		expect(out).toContain(`${p.blue}${p.underline}\u5360\u4f4d\u56fe`);
		expect(plain(inlineSpans("![](https://e.com/a.png)", ""))).toBe("image (https://e.com/a.png)");
		expect(plain(inlineSpans("![\u5f15\u7528\u56fe][img1]", ""))).toBe("image \u5f15\u7528\u56fe [img1]");
	});
});

describe("R2f — reference links and their definitions", () => {
	it("[text][label] reads as a link with its label dim; [text][] as the link alone; a bare [label] stays", () => {
		const p = palette();
		const out = inlineSpans("[\u5f15\u7528\u94fe\u63a5][ref1]\uff0c\u518d\u6765\u4e00\u6b21 [ref1]\u3002", "");
		expect(plain(out)).toBe("\u5f15\u7528\u94fe\u63a5 [ref1]\uff0c\u518d\u6765\u4e00\u6b21 [ref1]\u3002");
		expect(out).toContain(`${p.blue}${p.underline}\u5f15\u7528\u94fe\u63a5`);
		expect(out).toContain(`${p.dim} [ref1]${p.reset}`);
		expect(plain(inlineSpans("[\u6587\u5b57][]", ""))).toBe("\u6587\u5b57");
	});

	it("each definition is a dim row of its own: [label] url · title", () => {
		const p = palette();
		const md = '\u5217\u8868\u4e4b\u540e\n\n[ref1]: https://example.com/reference "\u5f15\u7528\u5f0f\u94fe\u63a5\u76ee\u6807"\n[img1]: https://via.placeholder.com/60\n';
		const r = renderMarkdown(md, 80);
		expect(r.map(plain)).toEqual(["\u5217\u8868\u4e4b\u540e", "", "[ref1] https://example.com/reference · \u5f15\u7528\u5f0f\u94fe\u63a5\u76ee\u6807", "[img1] https://via.placeholder.com/60"]);
		expect(r[2]!.startsWith(p.dim)).toBe(true);
	});

	it("a definition line starts its own block even right under a paragraph (the declared deviation)", () => {
		expect(rows("\u6587\u5b57\n[a]: https://e.com")).toEqual(["\u6587\u5b57", "", "[a] https://e.com"]);
	});
});

describe("R2f — <br>", () => {
	it("breaks a paragraph's row", () => {
		expect(rows("\u5f3a\u5236\u6362\u884c<br>\u7b2c\u4e8c\u884c and <BR/> third")).toEqual(["\u5f3a\u5236\u6362\u884c", "\u7b2c\u4e8c\u884c and", "third"]);
	});

	it("makes a table cell two rows, the column as wide as its widest row", () => {
		const t = rows("| \u6548\u679c | \u5199\u6cd5 |\n|---|---|\n| \u5f3a\u5236\u6362\u884c<br>\u7b2c\u4e8c\u884c | `<br>` |\n");
		const body = t.filter((x) => x.startsWith("│"));
		const first = body.find((x) => x.includes("\u5f3a\u5236\u6362\u884c"))!;
		// the cell's two rows: the second line sits under the first, never beside it
		expect(first).not.toContain("\u7b2c\u4e8c\u884c");
		expect(body[body.indexOf(first) + 1]).toContain("\u7b2c\u4e8c\u884c");
		// a `<br>` quoted in a code span is code — literal
		expect(first).toContain("<br>");
		const widths = new Set(t.map((x) => visibleWidth(x)));
		expect(widths.size).toBe(1); // every grid row the same width: the rails line up
	});
});

describe("R2f — invariants", () => {
	const DOC = [
		"| \u6548\u679c | \u5199\u6cd5 |",
		"|---|---|",
		"| ***\u7c97\u659c\u4f53*** | `***\u7c97\u659c\u4f53***` |",
		"| `\u884c\u5185\u4ee3\u7801` | `` `\u884c\u5185\u4ee3\u7801` `` |",
		"| \u5f3a\u5236\u6362\u884c<br>\u7b2c\u4e8c\u884c | `<br>` |",
		"| \u7ec4\u5408\uff1a**\u7c97\u4f53\u91cc\u7684 `\u4ee3\u7801` \u548c *\u659c\u4f53*** | \u5d4c\u5957\u6d4b\u8bd5 |",
		"",
		"- \u5e26\u6807\u9898\u7684\u94fe\u63a5\uff1a[\u60ac\u505c\u6709\u63d0\u793a](https://example.com \"\u8fd9\u662f title \u5c5e\u6027\")",
		"- \u81ea\u52a8\u94fe\u63a5\uff1a<https://github.com/>",
		"- \u5f15\u7528\u5f0f\u94fe\u63a5\uff1a[\u5f15\u7528\u94fe\u63a5][ref1]",
		"- \u56fe\u7247\uff1a![\u5360\u4f4d\u56fe](https://via.placeholder.com/120x40 \"\u56fe\u7247\")",
		"",
		"[ref1]: https://example.com/reference \"\u5f15\u7528\u5f0f\u94fe\u63a5\u76ee\u6807\"",
		"[img1]: https://via.placeholder.com/60",
		"",
	].join("\n");

	it("every row fits and none carries a newline, W 20..160, three grounds", () => {
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (let W = 20; W <= 160; W += 1) {
				for (const r of renderMarkdown(DOC, W)) {
					expect(visibleWidth(r), `${g} W=${W} ${JSON.stringify(plain(r))}`).toBeLessThanOrEqual(W);
					expect(r.includes("\n"), `${g} W=${W}`).toBe(false);
				}
			}
		}
	});

	it("streamed a character at a time, a closed block's rows never change", () => {
		const s = new MdStream();
		const seen: string[][] = [];
		for (const ch of DOC) {
			s.push(ch);
			const blocks = s.blocks();
			for (let i = 0; i < s.closed(); i += 1) {
				const r = renderBlock(blocks[i]!, 80);
				if (seen[i] === undefined) seen[i] = r;
				else expect(r, `block ${i}`).toEqual(seen[i]);
			}
		}
	});
});
