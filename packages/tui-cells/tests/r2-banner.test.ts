/**
 * R2 — the opening screen, ruled 2026-08-27 (the nineteen-screen review).
 *
 * The ASCII wordmark is retired. It was tried as a clover mark at four
 * sizes first and rejected on measurement — below fourteen columns the
 * centre star closes and the mark reads as a domino, and at fourteen it
 * costs seven rows to say what the word `kiso` says in one.
 *
 * What replaces it is not decoration: three labelled facts answering the
 * three questions a first screen is actually asked — what model, where
 * am I, what is loaded — and one dim row of keys.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bannerLines } from "../src/render.js";

beforeEach(() => Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true }));
afterEach(() => delete (process.stdout as { isTTY?: boolean }).isTTY);

const plain = (rows: string[]): string[] => rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""));
const META = { model: "deepseek-v4-flash", mode: "bypass", cwd: "~/Desktop/devv/kiso" };

describe("R2 — the opening", () => {
	it("carries no wordmark at any width or height", () => {
		for (const [W, H] of [
			[80, 40],
			[100, 24],
			[40, 14],
			[30, 10],
		]) {
			const text = plain(bannerLines(W!, H!, "0.16.2", "4 extensions: ask, mcp", [], 0, META)).join("\n");
			expect(text, `${W}x${H}`).not.toMatch(/[█▀▄]/);
		}
	});

	it("names itself once, with the version beside it", () => {
		expect(plain(bannerLines(80, 40, "0.16.2", "", [], 0, META))[0]).toBe("kiso 0.16.2");
	});

	it("answers the three questions, in one aligned column", () => {
		const rows = plain(bannerLines(80, 40, "0.16.2", "4 extensions: ask, mcp", [], 0, META));
		const labelled = rows.filter((r) => /^ {2}[A-Z]/.test(r));
		expect(labelled).toHaveLength(3);
		expect(labelled[0]).toContain("MODEL");
		expect(labelled[0]).toContain("deepseek-v4-flash · bypass");
		expect(labelled[1]).toContain("WORKSPACE");
		expect(labelled[1]).toContain("~/Desktop/devv/kiso");
		expect(labelled[2]).toContain("EXTENSIONS");
		// one column: every value starts at the same place
		const starts = labelled.map((r) => r.length - r.replace(/^ {2}[A-Z]+ +/, "").length);
		expect(new Set(starts).size).toBe(1);
	});

	it("teaches the keys in one dim row", () => {
		const rows = plain(bannerLines(80, 40, "0.16.2", "", [], 0, META));
		expect(rows.some((r) => r.includes("esc") && r.includes("/ commands"))).toBe(true);
	});

	it("without the meta it still renders — the off-TTY caller has no model", () => {
		const rows = plain(bannerLines(80, 40, "0.16.2", "4 extensions: ask", []));
		expect(rows[0]).toBe("kiso 0.16.2");
		expect(rows.some((r) => r.includes("MODEL"))).toBe(false);
		expect(rows.some((r) => r.includes("EXTENSIONS"))).toBe(true);
	});

	it("every row still fits the width", () => {
		for (const W of [80, 60, 44, 30, 20]) {
			for (const row of plain(bannerLines(W, 40, "0.16.2", "4 extensions: ask, mcp, skills, task", [], 0, META))) {
				expect(row.length, `W=${W}: ${JSON.stringify(row)}`).toBeLessThanOrEqual(W);
			}
		}
	});
});
