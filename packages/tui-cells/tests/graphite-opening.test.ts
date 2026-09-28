/**
 * Graphite §7.10 — the opening: the wordmark, then what loaded.
 *
 * DECLARED REVERSAL of R2 (2026-08-27, the nineteen-screen review), whose
 * gates this file carried: "carries no wordmark at any width or height",
 * "answers the three questions" (MODEL / WORKSPACE / EXTENSIONS) and
 * "teaches the keys in one dim row". The Graphite round (owner-ruled
 * 2026-09-28) brought the wordmark back and moved the answers: the model
 * and the folder to the status bar (§8.9), what loaded beside the
 * wordmark, the keys to the empty input (§7.8). The invariant ① gate is
 * kept and widened.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bannerLines, setGround, WORDMARK_W, type BannerMeta } from "../src/render.js";
import { fg, graphiteColours, mix } from "../src/graphite.js";

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

describe("§7.10 — the tall form", () => {
	it("at 100×40: the wordmark at the content edge, the facts beside it behind one hairline", () => {
		const rows = plain(bannerLines(100, 40, "0.44.0", "", [], 0, META));
		expect(WORDMARK_W).toBe(28);
		for (let i = 0; i < 6; i += 1) {
			expect(rows[i]!.slice(0, 4), `row ${i}`).toBe("    ");
			expect(rows[i]!.slice(4, 6), `row ${i}`).toMatch(/[█╚]/);
			expect(rows[i]![34], `the hairline, row ${i}`).toBe("│");
		}
		expect(rows[0]!.slice(37)).toBe("SESSION     new · resumable after kill -9");
		expect(rows[3]!.slice(37)).toBe("MCP         2 servers · 14 tools");
		expect(rows[4]!.slice(34)).toBe("│");
		expect(rows[6]).toBe(`    ${"─".repeat(28)}`);
		expect(rows[7]).toBe("    the coding agent that survives kill -9 · 0.44.0");
		expect(rows[8]).toBe("    intent → effect → durable fact");
		expect(rows).toHaveLength(9);
	});

	it("under 96 columns the facts move below it, label column and all", () => {
		const rows = plain(bannerLines(80, 40, "0.44.0", "", [], 0, META));
		expect(rows[0]!.trimEnd()).toBe("    ██╗  ██╗██╗███████╗ ██████╗");
		expect(rows.slice(9)).toEqual(["", "    SESSION     new · resumable after kill -9", "    RULES       AGENTS.md", "    SKILLS      3 · /skills lists them", "    MCP         2 servers · 14 tools"]);
	});

	it("more facts than the wordmark has rows go below it at any width", () => {
		const many: BannerMeta = { facts: Array.from({ length: 7 }, (_, i) => ({ label: `F${i}`, value: "v" })) };
		const rows = plain(bannerLines(140, 40, "0.44.0", "", [], 0, many));
		expect(rows.some((r) => r.includes("│"))).toBe(false);
		expect(rows.filter((r) => /^ {4}F\d/.test(r))).toHaveLength(7);
	});
});

describe("§7.10 — the one-line form", () => {
	it("under 30 rows", () => {
		const rows = plain(bannerLines(100, 29, "0.44.0", "", [], 0, META));
		expect(rows[0]).toBe("  ✦ kiso 0.44.0 · the coding agent that survives kill -9");
		expect(rows[1]).toBe("");
		expect(rows[2]).toBe("    SESSION     new · resumable after kill -9");
		expect(rows.join("\n")).not.toMatch(/[█╗╝]/);
	});

	it("on a resume, however tall the terminal: the history is above it", () => {
		const rows = plain(bannerLines(120, 60, "0.44.0", "", [], 0, { ...META, resumed: true }));
		expect(rows[0]).toBe("  ✦ kiso 0.44.0 · the coding agent that survives kill -9");
		expect(rows.join("\n")).not.toContain("█");
	});

	it("on a terminal too narrow for the wordmark at the content edge", () => {
		expect(plain(bannerLines(31, 40, "0.44.0", "", [], 0, META))[0]!.startsWith("  ✦ kiso")).toBe(true);
		expect(plain(bannerLines(32, 40, "0.44.0", "", [], 0, META))[0]).toContain("██╗");
	});

	it("a fact that does not fit loses its note first, then is cut", () => {
		const rows = plain(bannerLines(40, 24, "0.44.0", "", [], 0, META));
		expect(rows).toContain("    SESSION     new");
		expect(rows, "a fact that fits keeps its note").toContain("    MCP         2 servers · 14 tools");
		const narrow = plain(bannerLines(18, 24, "0.44.0", "", [], 0, META));
		expect(narrow).toContain("    SESSION     n…");
	});
});

describe("§7.10 — a long fact hangs under itself", () => {
	it("the extensions list folds by word at the value column, never cut — it is what loaded", () => {
		const list = "[6 extensions: built-in: mcp, skills, subagent, ask (off in dontAsk) · project: lint-guard, release-notes]";
		const rows = plain(bannerLines(80, 24, "0.44.0", "", [], 0, { facts: [{ label: "EXTENSIONS", value: list }] }));
		const at = rows.findIndex((r) => r.startsWith("    EXTENSIONS  [6"));
		expect(at).toBeGreaterThan(0);
		const hung = rows.slice(at).filter((r) => r !== "");
		expect(hung.length).toBeGreaterThan(1);
		for (const r of hung.slice(1)) expect(r.match(/^ */)![0].length, r).toBe(16);
		expect(hung.map((r) => r.trim().replace(/^EXTENSIONS\s+/, "")).join(" ")).toBe(list);
		for (const r of hung) expect(r.length).toBeLessThanOrEqual(80);
	});

	it("beside the wordmark only while the folded facts fit its six rows", () => {
		const long = { facts: [...META.facts, { label: "EXTENSIONS", value: "x ".repeat(60).trim() }] };
		expect(plain(bannerLines(100, 40, "0.44.0", "", [], 0, long)).some((r) => r.includes("│"))).toBe(false);
	});
});

describe("§7.10 — the colours", () => {
	it("on a known ground: block cells step from ink to dim, the shadow is rail toward the ground, no gold anywhere", () => {
		setGround("light");
		const c = graphiteColours("light", null, "24bit");
		const rows = bannerLines(100, 40, "0.44.0", "", [], 0, META);
		expect(rows[0]).toContain(`${fg(c.ink, "24bit")}██`);
		expect(rows[4]).toContain(`${fg(c.dim, "24bit")}██`);
		expect(rows[2]).toContain(`${fg(mix(c.ink, c.dim, 0.5), "24bit")}██`);
		expect(rows[0]).toContain(`${fg(mix(c.rail, c.ground, 0.35), "24bit")}╗`);
		expect(rows[6]!.startsWith(`    ${fg(c.dim, "24bit")}─`)).toBe(true);
		const all = rows.join("\n");
		for (const gold of [c.gold, c.goldMark]) expect(all).not.toContain(fg(gold, "24bit"));
	});

	it("off a known ground the wordmark is the terminal's own foreground", () => {
		const rows = bannerLines(100, 40, "0.44.0", "", [], 0, META);
		for (let i = 0; i < 6; i += 1) expect(rows[i]!.slice(0, 40), `row ${i}`).not.toMatch(/\x1b\[38;/);
	});
});

describe("§7.10 — without the facts", () => {
	it("the head alone; a bare extensions text still gets its row", () => {
		expect(plain(bannerLines(80, 24, "0.44.0", ""))).toEqual(["  ✦ kiso 0.44.0 · the coding agent that survives kill -9"]);
		const rows = plain(bannerLines(80, 24, "0.44.0", "[2 extensions: ask, mcp]"));
		expect(rows[2]).toBe("    EXTENSIONS  [2 extensions: ask, mcp]");
	});
});

describe("invariant ① — every row fits, at every width, height and ground", () => {
	it("W 1..200 × H {10, 29, 30, 60} × {light, dark, unknown}", () => {
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (const H of [10, 29, 30, 60]) {
				for (let W = 1; W <= 200; W += 1) {
					for (const row of plain(bannerLines(W, H, "0.44.0", "", [], 0, META))) {
						expect([...row].length, `${g} ${W}x${H}: ${JSON.stringify(row)}`).toBeLessThanOrEqual(W);
					}
				}
			}
		}
	});
});
