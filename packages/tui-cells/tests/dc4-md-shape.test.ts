/**
 * DC-4 + E1/E2 — the shape of rendered markdown, ruled 2026-08-27.
 *
 * Three decisions, one philosophy: what the terminal draws should still
 * be markdown when a human selects it and pastes it somewhere else.
 *
 *   HEADINGS — every level was rendered identically (bold), so a
 *   document arrived flat. Levels 1 and 2 are carried by attributes;
 *   from level 3 the `###` itself is shown, because attributes have run
 *   out and the marker is the only thing left that survives a pipe.
 *
 *   LISTS — `-`, `*` and `+` still normalise to ONE marker, so the
 *   model's arbitrary choice does not leak onto the screen; the marker
 *   is now `- ` rather than `•`, so a copied list is still a list.
 *
 *   FENCES — the ``` rails are drawn instead of a `│` gutter. A copied
 *   block is a fenced block. The closing rail appears only on an actual
 *   close: an unterminated fence draws no bottom, which is the truth.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MdStream, renderBlock, renderMarkdown } from "../src/md.js";
import { COLOR_ON } from "../src/render.js";

beforeEach(() => Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true }));
afterEach(() => delete (process.stdout as { isTTY?: boolean }).isTTY);

const plain = (rows: string[]): string[] => rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""));

describe("DC-4 — heading levels are distinguishable", () => {
	it("level 3 and below show their own marker, so the level survives a pipe", () => {
		expect(plain(renderMarkdown("### Step three", 60))).toContain("### Step three");
		expect(plain(renderMarkdown("#### Step four", 60))).toContain("#### Step four");
	});

	it("levels 1 and 2 strip the marker and are told apart by attribute", () => {
		const h1 = renderMarkdown("# Overview", 60).join("");
		const h2 = renderMarkdown("## Detail", 60).join("");
		expect(plain([h1])[0]).toContain("Overview");
		expect(plain([h1])[0]).not.toContain("#");
		expect(h1).toContain(COLOR_ON.underline);
		expect(h2).not.toContain(COLOR_ON.underline);
		expect(h2).toContain(COLOR_ON.bold);
	});

	it("three levels render three different rows — the defect, gone", () => {
		const rows = plain(renderMarkdown("# A\n\n## B\n\n### C", 60)).filter((r) => r.trim() !== "");
		expect(new Set(rows).size).toBe(3);
	});
});

describe("E1 — one list marker, and it is markdown", () => {
	it("normalises -, * and + to `- `", () => {
		for (const src of ["- one", "* one", "+ one"]) {
			expect(plain(renderMarkdown(src, 60))[0]).toBe("  - one");
		}
	});

	it("a numbered list keeps its numbers — they are the author's meaning", () => {
		expect(plain(renderMarkdown("3. third", 60))[0]).toBe("  3. third");
	});

	it("no bullet glyph survives anywhere", () => {
		expect(plain(renderMarkdown("- a\n- b\n  - c", 60)).join("")).not.toContain("•");
	});
});

describe("E2 — a fenced block keeps its rails", () => {
	it("draws the opening rail with the language, and the body without a gutter", () => {
		const rows = plain(renderMarkdown("```ts\nconst a = 1;\n```", 60));
		expect(rows[0]).toBe("```ts");
		expect(rows[1]).toBe("  const a = 1;");
		expect(rows[2]).toBe("```");
	});

	it("a language-less fence opens with a bare rail", () => {
		expect(plain(renderMarkdown("```\nplain\n```", 60))[0]).toBe("```");
	});

	it("no `│` gutter is left on a code block", () => {
		expect(plain(renderMarkdown("```\nx\n```", 60)).join("")).not.toContain("│");
	});

	it("an UNTERMINATED fence draws no bottom rail — the block is not closed", () => {
		const s = new MdStream();
		s.push("```ts\nconst a = 1;\n");
		const rows = plain(s.blocks().flatMap((b) => renderBlock(b, 60)));
		expect(rows).toEqual(["```ts", "  const a = 1;"]);
	});

	it("the bottom rail arrives with the close, and only then", () => {
		const s = new MdStream();
		s.push("```ts\nconst a = 1;\n");
		expect(plain(s.blocks().flatMap((b) => renderBlock(b, 60)))).toHaveLength(2);
		s.push("```\n");
		expect(plain(s.blocks().flatMap((b) => renderBlock(b, 60)))).toEqual(["```ts", "  const a = 1;", "```"]);
	});

	it("a partial closing rail still never renders", () => {
		const s = new MdStream();
		s.push("```ts\nconst a = 1;\n");
		for (const tick of ["`", "`", "`"]) {
			s.push(tick);
			expect(s.blocks().flatMap((b) => renderBlock(b, 60))).toHaveLength(2);
		}
	});
});
