/**
 * Graphite §7.10 — the opening: the wordmark, then what loaded.
 *
 * DECLARED REVERSAL of R2 (2026-08-27, the nineteen-screen review), whose
 * gates this file carried: "carries no wordmark at any width or height",
 * "answers the three questions" (MODEL / WORKSPACE / EXTENSIONS) and
 * "teaches the keys in one dim row". The Graphite round (owner-ruled
 * 2026-09-28) brought the wordmark back and moved the answers: the model
 * and the folder to the status bar (§8.9), what loaded beside the
 * wordmark, the keys to `?`. The invariant ① gate is kept and widened.
 *
 * Settled with the owner on 2026-09-29: the opening starts at the content
 * edge, column 2 (the 0.44 geometry); the wordmark shows from 20 rows — the
 * 80×24 window a Mac opens by default (a wordmark that window never shows
 * is not worth drawing); its letters are BACKGROUND cells, because `█`
 * glyphs left a white line through every row in Apple Terminal (the seam
 * test, C1 against C2).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bannerLines, setGround, WORDMARK_W, type BannerMeta } from "../src/render.js";
import { bg, fg, graphiteColours, mix } from "../src/graphite.js";

beforeEach(() => Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true }));
afterEach(() => {
	setGround("unknown");
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

const plain = (rows: string[]): string[] => rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""));
const META: BannerMeta = {
	facts: [
		{ label: "SESSION", value: "new", note: "resumable after kill -9" },
		{ label: "RULES", value: "AGENTS.md" },
		{ label: "SKILLS", value: "3", note: "/skills lists them" },
		{ label: "MCP", value: "2 servers", note: "14 tools" },
	],
};

/**
 * The prototype's layout (owner, 2026-09-29: "follow the prototype's
 * layout and lines"): the wordmark, a forty-column rule, the tagline and
 * the motto on the left; what loaded on the RIGHT, pushed to the right
 * edge and to the bottom of the left column, behind a hairline down its
 * left side; a blank row and a hairline across the width close it.
 */
describe("§7.10 — the tall form", () => {
	it("at 180×40: the facts on the right, bottom-aligned, bordered; the opening closed by a hairline", () => {
		const rows = plain(bannerLines(180, 40, "0.44.0", "", [], 0, META));
		expect(WORDMARK_W).toBe(28);
		for (let i = 0; i < 6; i += 1) expect(rows[i]!.slice(0, 2), `row ${i}`).toBe("  ");
		expect(rows[6]!.slice(0, 42)).toBe(`  ${"─".repeat(40)}`);
		expect(rows[7]!.startsWith("  the coding agent that survives kill -9 · 0.44.0")).toBe(true);
		expect(rows[8]!.startsWith("  intent → effect → durable fact")).toBe(true);
		// four facts, bottom-aligned with the motto: rows 5..8
		for (const r of rows.slice(0, 5)) expect(r, "a fact above its place").not.toContain("│");
		const facts = rows.slice(5, 9).map((r) => r.slice(r.indexOf("│")));
		expect(facts).toEqual(["│  SESSION     new · resumable after kill -9", "│  RULES       AGENTS.md", "│  SKILLS      3 · /skills lists them", "│  MCP         2 servers · 14 tools"]);
		// pushed right: the widest fact ends two columns short of the edge
		const col = rows[5]!.indexOf("│");
		expect(col + "│  SESSION     new · resumable after kill -9".length).toBe(180 - 2);
		for (const r of rows.slice(5, 9)) expect(r.indexOf("│"), "the border is one column").toBe(col);
		expect(rows[9]).toBe("");
		expect(rows[10]).toBe("─".repeat(180));
		expect(rows).toHaveLength(11);
	});

	it("when the width cannot hold both, the facts move below the left column, border and all", () => {
		const rows = plain(bannerLines(80, 24, "0.44.0", "", [], 0, META));
		expect(rows[0]!.trimEnd()).toBe("  ██╗  ██╗██╗███████╗ ██████╗");
		expect(rows.slice(9)).toEqual(["", "  │  SESSION     new · resumable after kill -9", "  │  RULES       AGENTS.md", "  │  SKILLS      3 · /skills lists them", "  │  MCP         2 servers · 14 tools", "", "─".repeat(80)]);
	});

	it("the 80×24 window a Mac opens by default shows the wordmark — from 20 rows", () => {
		expect(plain(bannerLines(80, 24, "0.44.0", "", [], 0, META)).join("\n")).toContain("██╗");
		expect(plain(bannerLines(80, 20, "0.44.0", "", [], 0, META)).join("\n")).toContain("██╗");
		expect(plain(bannerLines(80, 19, "0.44.0", "", [], 0, META)).join("\n")).not.toContain("██╗");
	});

	it("facts taller than the left column push it down: both columns end on the same row", () => {
		const many: BannerMeta = { facts: Array.from({ length: 12 }, (_, i) => ({ label: `F${i}`, value: "v" })) };
		const rows = plain(bannerLines(180, 40, "0.44.0", "", [], 0, many));
		const last = rows.findIndex((r) => r.includes("intent → effect"));
		expect(rows[last]).toContain("F11");
		expect(rows[0]).toContain("F0");
		expect(rows[0]!.trim().startsWith("│"), "the wordmark was pushed down, not cut").toBe(true);
	});
});

describe("§7.10 — the one-line form", () => {
	it("under 20 rows: the mark in the mark column, the words at the edge, the facts bordered below", () => {
		const rows = plain(bannerLines(100, 19, "0.44.0", "", [], 0, META));
		expect(rows[0]).toBe("✦ kiso 0.44.0 · the coding agent that survives kill -9");
		expect(rows[1]).toBe("");
		expect(rows[2]).toBe("  │  SESSION     new · resumable after kill -9");
		expect(rows.at(-1)).toBe("─".repeat(100));
		expect(rows.join("\n")).not.toMatch(/[█╗╝]/);
	});

	it("on a resume, however tall the terminal: the history is above it", () => {
		const rows = plain(bannerLines(120, 60, "0.44.0", "", [], 0, { ...META, resumed: true }));
		expect(rows[0]).toBe("✦ kiso 0.44.0 · the coding agent that survives kill -9");
		expect(rows.join("\n")).not.toContain("█");
	});

	it("on a terminal too narrow for the wordmark at the content edge", () => {
		expect(plain(bannerLines(29, 40, "0.44.0", "", [], 0, META))[0]!.startsWith("✦ kiso")).toBe(true);
		expect(plain(bannerLines(30, 40, "0.44.0", "", [], 0, META))[0]).toContain("██╗");
	});

	it("a fact that does not fit loses its note first, then is cut", () => {
		const rows = plain(bannerLines(40, 19, "0.44.0", "", [], 0, META));
		expect(rows).toContain("  │  SESSION     new");
		expect(rows, "a fact that fits keeps its note").toContain("  │  MCP         2 servers · 14 tools");
		const narrow = plain(bannerLines(19, 19, "0.44.0", "", [], 0, META));
		expect(narrow).toContain("  │  SESSION     n…");
	});
});

describe("§7.10 — a long fact hangs under itself", () => {
	it("the extensions list folds by word at the value column, never cut — it is what loaded", () => {
		const list = "[6 extensions: built-in: mcp, skills, subagent, ask (off in dontAsk) · project: lint-guard, release-notes]";
		const rows = plain(bannerLines(80, 19, "0.44.0", "", [], 0, { facts: [{ label: "EXTENSIONS", value: list }] }));
		const at = rows.findIndex((r) => r.startsWith("  │  EXTENSIONS  [6"));
		expect(at).toBeGreaterThan(0);
		const hung = rows.slice(at).filter((r) => r.includes("│"));
		expect(hung.length).toBeGreaterThan(1);
		for (const r of hung.slice(1)) expect(r.match(/^ {2}│ +/)![0].length, r).toBe(17);
		expect(hung.map((r) => r.replace(/^ {2}│ +/, "").replace(/^EXTENSIONS\s+/, "")).join(" ")).toBe(list);
		for (const r of hung) expect(r.length).toBeLessThanOrEqual(80);
	});
});

describe("§7.10 — the colours", () => {
	it("on a known ground: the letters are BACKGROUND cells stepping from ink to dim, the shadow rail toward the ground, no gold, no █", () => {
		setGround("light");
		const c = graphiteColours("light", null, "24bit");
		const rows = bannerLines(100, 40, "0.44.0", "", [], 0, META);
		expect(rows[0]).toContain(`${bg(c.ink, "24bit")}  `);
		expect(rows[4]).toContain(`${bg(c.dim, "24bit")}  `);
		expect(rows[2]).toContain(`${bg(mix(c.ink, c.dim, 0.5), "24bit")}     `);
		expect(rows[0]).toContain(fg(mix(c.rail, c.ground, 0.35), "24bit"));
		for (const r of rows.slice(0, 6)) expect(r, "a █ glyph drew a letter (§1.5)").not.toContain("█");
		expect(rows[6]!.startsWith(`  ${fg(c.dim, "24bit")}─`)).toBe(true);
		const all = rows.join("\n");
		for (const gold of [c.gold, c.goldMark]) expect(all).not.toContain(fg(gold, "24bit"));
	});

	it("off a known ground the wordmark is the terminal's own foreground, in █", () => {
		const rows = bannerLines(100, 40, "0.44.0", "", [], 0, META);
		for (let i = 0; i < 6; i += 1) expect(rows[i]!.slice(0, 32), `row ${i}`).not.toMatch(/\x1b\[(?:38|48);/);
		expect(rows[0]).toContain("██");
	});
});

describe("§7.10 — without the facts", () => {
	it("the head alone (help's form, no closing rule); a bare extensions text still gets its row", () => {
		expect(plain(bannerLines(80, 19, "0.44.0", ""))).toEqual(["✦ kiso 0.44.0 · the coding agent that survives kill -9"]);
		const rows = plain(bannerLines(80, 19, "0.44.0", "[2 extensions: ask, mcp]"));
		expect(rows[2]).toBe("  │  EXTENSIONS  [2 extensions: ask, mcp]");
	});
});

describe("invariant ① — every row fits, at every width, height and ground", () => {
	it("W 1..200 × H {10, 19, 20, 60} × {light, dark, unknown}", () => {
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (const H of [10, 19, 20, 60]) {
				for (let W = 1; W <= 200; W += 1) {
					for (const row of plain(bannerLines(W, H, "0.44.0", "", [], 0, META))) {
						expect([...row].length, `${g} ${W}x${H}: ${JSON.stringify(row)}`).toBeLessThanOrEqual(W);
					}
				}
			}
		}
	});
});
