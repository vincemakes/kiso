/**
 * Graphite §5 (R2b) — the answer's markdown in Graphite, and the person's
 * own words rendered as markdown (G6). Off a known ground the mono forms
 * stay (DC-4: a marker is the only carrier there).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cellComponent, type FrameCtx } from "../src/components.js";
import { MdStream, renderMarkdown, type MdBlock } from "../src/md.js";
import { COLOR_DARK, COLOR_LIGHT, palette, setGround } from "../src/render.js";
import { visibleWidth } from "../src/width.js";

beforeAll(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => setGround("unknown"));

const CTX: FrameCtx = { spinnerI: 0, now: 10_000, height: 60 };
const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
const blocks = (text: string): readonly MdBlock[] => {
	const s = new MdStream();
	s.push(text);
	s.end();
	return s.blocks();
};
/** The answer as the transcript draws it: every block at the content edge. */
const answer = (text: string, W = 80): string[] => blocks(text).flatMap((b) => cellComponent({ kind: "md", block: b, done: true } as never).render(W, CTX));

const DOC = [
	"# Retry policy",
	"",
	"## What changed",
	"",
	"The adapter retries **only** idempotent calls, with `MAX = 5`. See [the ADR](https://example.com/adr) — the old ~~fixed~~ delay is gone.",
	"",
	"### Steps",
	"",
	"1. read the config",
	"2. build the client",
	"   - with `timeout`",
	"- [x] tests pass",
	"- [ ] docs updated",
	"",
	"#### notes for `hosts`",
	"",
	"> Retries never cross a kill -9.",
	"",
	"> [!NOTE]",
	"> The window is read from the registry.",
	"",
	"> [!WARNING]",
	"> A call that wrote a file is never retried.",
	"",
	"> [!CAUTION]",
	"> Bypass runs everything.",
	"",
	"| flag | default |",
	"|---|---:|",
	"| `--retries` | 5 |",
	"",
	"---",
	"",
	"That is all.",
].join("\n");

describe("§5 — the answer on a known ground", () => {
	it("headings: `#` gold over a fading rule, `##` blue with `§` in the mark column, `###` bold, `####` dim upper case outside code; no `#` printed", () => {
		setGround("light");
		const p = palette();
		const rows = answer(DOC);
		const h1 = rows.findIndex((r) => plain(r) === "  Retry policy");
		expect(h1).toBeGreaterThanOrEqual(0);
		expect(rows[h1]).toContain(`${p.bold}${p.gold}Retry policy`);
		expect(plain(rows[h1 + 1]!)).toBe(`  ${"─".repeat(40)}`);
		const h2 = rows.find((r) => plain(r).endsWith("What changed"))!;
		expect(plain(h2)).toBe("§ What changed");
		expect(h2.startsWith(`${p.rail}§`)).toBe(true);
		expect(h2).toContain(`${p.bold}${p.blue}What changed`);
		expect(rows.map(plain)).toContain("  Steps");
		const h4 = rows.find((r) => plain(r).startsWith("  NOTES FOR"))!;
		expect(plain(h4)).toBe("  NOTES FOR hosts");
		expect(h4).toContain(`${p.bold}${p.dim}`);
		expect(rows.map(plain).join("\n")).not.toMatch(/^\s*#/m);
	});

	it("inline: code blue with no ground, a link blue and underlined with its url dim after it, struck text dim", () => {
		setGround("light");
		const p = palette();
		const row = answer(DOC).find((r) => plain(r).includes("idempotent"))!;
		expect(row).toContain(`${p.blue}MAX = 5${p.fgEnd}`);
		// no ground under it (owner, 2026-09-29)
		expect(row).not.toContain(p.codeBg);
		// at a width where the sentence is one row, so no fold splits the span
		const all = answer(DOC, 200).join("\n");
		expect(all).toContain(`${p.blue}${p.underline}the ADR${p.underlineEnd}${p.fgEnd}${p.dim} (https://example.com/adr)`);
		expect(all).toContain(`${p.dim}fixed${p.reset}`);
		expect(plain(all)).not.toContain("~~");
	});

	it("lists: `–` then `·`, numbers dim, tasks `✓` (ok) and `○` (dim) in place of the bullet", () => {
		setGround("light");
		const p = palette();
		const rows = answer(DOC);
		const text = rows.map(plain);
		expect(text).toContain("    1. read the config");
		expect(text).toContain("      · with timeout");
		expect(text).toContain("    ✓ tests pass");
		expect(text).toContain("    ○ docs updated");
		expect(rows.find((r) => plain(r).includes("tests pass"))).toContain(`${p.ok}✓`);
		expect(rows.find((r) => plain(r).includes("docs updated"))).toContain(`${p.dim}○`);
		expect(answer("- one\n- two").map(plain)).toEqual(["    – one", "    – two"]);
	});

	it("a quote: a bar of BACKGROUND, then italic ink2; an alert: its bar colour and its word", () => {
		setGround("light");
		const p = palette();
		const rows = answer(DOC);
		const quote = rows.find((r) => plain(r).includes("Retries never cross"))!;
		expect(quote).toContain(`${p.quoteBar} ${p.washEnd} `);
		expect(quote).toContain(`${p.italic}${p.ink2}Retries`);
		const note = rows.findIndex((r) => plain(r).trim() === "Note");
		expect(rows[note]).toContain(`${p.noteBar} `);
		expect(rows[note]).toContain(`${p.bold}${p.blue}Note`);
		expect(rows[note + 1]).toContain(`${p.noteBar} `);
		expect(rows.find((r) => plain(r).trim() === "Warning")).toContain(p.warnBar);
		expect(rows.find((r) => plain(r).trim() === "Caution")).toContain(p.cautionBar);
		// no `[!NOTE]` marker reaches the screen, and no glyph bar either
		expect(rows.map(plain).join("\n")).not.toMatch(/\[!|│ Retries/);
	});

	it("a table's rails in `edge`; the model's rule is three dots in `rail`", () => {
		setGround("light");
		const p = palette();
		const rows = answer(DOC);
		expect(rows.find((r) => plain(r).includes("┌"))).toContain(`${p.edge}┌`);
		const rule = rows.find((r) => plain(r).trim() === "·  ·  ·")!;
		expect(rule).toContain(`${p.rail}·  ·  ·`);
	});

	it("R2c: a fence's lines are blue with no ground, its rails dim as before (E2 stands: a copied block is still fenced)", () => {
		setGround("light");
		const p = palette();
		const rows = answer("```ts\nconst a = 1;\n  return a;\n```", 80);
		expect(rows.map(plain)).toEqual(["  ```ts", "    const a = 1;", "      return a;", "  ```"]);
		expect(rows[1]).toContain(`${p.blue}const a = 1;${p.fgEnd}`);
		for (const r of rows) {
			expect(r).not.toContain(p.codeBg);
			expect(r).not.toContain(p.washDone);
		}
		setGround("unknown");
		expect(answer("```\nx\n```", 80)[1]).toBe("    x");
	});

	it("the seam law (§1.5): no block-element glyph anywhere in the answer", () => {
		for (const g of ["light", "dark"] as const) {
			setGround(g);
			for (const r of answer(DOC)) expect(plain(r), r).not.toMatch(/[▀-▟]/);
		}
	});
});

describe("§5 — off a known ground the mono forms stay", () => {
	it("the unknown ground: `###` printed, `- ` bullets, the `│` gutter, a solid rule", () => {
		setGround("unknown");
		const text = answer(DOC).map(plain);
		expect(text).toContain("  ### Steps");
		expect(text.some((r) => r.startsWith("    - "))).toBe(true);
		expect(text.some((r) => r.startsWith("  │ Retries"))).toBe(true);
		expect(text.some((r) => /^ {4}─+$/.test(r))).toBe(true);
	});
});

describe("invariant ① and the stream", () => {
	it("every row fits, W 20..200, on both grounds and the unknown one", () => {
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (let W = 20; W <= 200; W += 1) {
				for (const r of answer(DOC, W)) expect(visibleWidth(r), `${g} W=${W}: ${plain(r)}`).toBeLessThanOrEqual(W);
			}
		}
	});

	it("streamed == whole: the document fed a character at a time renders the same rows", () => {
		for (const g of ["light", "dark"] as const) {
			setGround(g);
			const s = new MdStream();
			for (const ch of DOC) s.push(ch);
			s.end();
			const streamed = s.blocks().flatMap((b) => cellComponent({ kind: "md", block: b, done: true } as never).render(80, CTX));
			expect(streamed).toEqual(answer(DOC));
		}
	});
});

describe("G6 — the person's own words as markdown", () => {
	const user = (text: string, W = 80): string[] => cellComponent({ kind: "user", text } as never).render(W, CTX);

	it("bold, code and the line breaks they typed; the warm ground re-opened after every reset", () => {
		setGround("light");
		const rows = user("please **retry** only safe calls,\nand keep `MAX` at 5");
		const text = rows.map(plain).map((r) => r.trimEnd());
		expect(text).toContain("  please retry only safe calls,");
		expect(text).toContain("  and keep MAX at 5");
		const p = palette();
		for (const r of rows) {
			// every reset is followed by the block's own ground
			for (const m of r.matchAll(/\x1b\[0m/g)) expect(r.slice(m.index! + 4).startsWith(p.human) || r.slice(m.index! + 4) === "", r).toBe(true);
			expect(r).not.toContain("\x1b[49m\x1b");
		}
		expect(rows.find((r) => plain(r).includes("retry"))).toContain(`${p.bold}retry`);
	});

	it("a pasted file: twelve rows, then the count outside the block", () => {
		setGround("light");
		const rows = user(Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n"));
		expect(rows.filter((r) => /line \d+/.test(plain(r)))).toHaveLength(12);
		expect(plain(rows[rows.length - 1]!)).toMatch(/sent in full/);
	});

	it("every row fits, W 20..200, on both grounds and the unknown one", () => {
		const text = "# a heading\n**bold** and `code` and a [link](https://example.com/a/very/long/path/that/wraps)\n- item\n> quoted";
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (let W = 20; W <= 200; W += 1) for (const r of user(text, W)) expect(visibleWidth(r), `${g} W=${W}: ${plain(r)}`).toBeLessThanOrEqual(W);
		}
	});

	it("the same words render the same rows: the block is a function of its text", () => {
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			expect(user("a **b**\nc")).toEqual(user("a **b**\nc"));
		}
		expect(renderMarkdown("a\nb", 40, { hardBreaks: true }).map(plain)).toEqual(["a", "b"]);
		expect(renderMarkdown("a\nb", 40).map(plain)).toEqual(["a b"]);
	});
});

// the palettes the gates read are the 24-bit ones the test environment runs in
void COLOR_LIGHT;
void COLOR_DARK;
