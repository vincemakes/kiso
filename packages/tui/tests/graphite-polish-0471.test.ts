/**
 * 0.47.1 — the polish round (owner, 2026-10-07): the agent's dogfood of
 * 0.47.0 found four cosmetic rough edges (findings 0470-F1 to F4). This
 * file holds the meta-row half; the cards' half is in kiso-tui-cells.
 */
import { describe, expect, it } from "vitest";
import { noticeMeta } from "../src/notice-meta.js";

describe("0470-F3: a COMPACTED row counts its rounds in English", () => {
	it("one round is singular on the terminal; the pipe's text is not touched", () => {
		// the dogfood's screen read `COMPACTED 1 rounds → 1 summary`
		expect(noticeMeta("[/compact] ✦ compacted · 1 rounds → 1 summary · saved ~0 · ctx 0% → 0% · 5.9s")).toEqual({
			label: "COMPACTED",
			sentence: "1 round → 1 summary · saved ~0 · ctx 0% → 0% · 5.9s",
		});
	});

	it("more rounds stay plural, and a count that only ends in 1 is not touched", () => {
		expect(noticeMeta("[/compact] ✦ compacted · 5 rounds → 1 summary · saved ~3k")).toEqual({ label: "COMPACTED", sentence: "5 rounds → 1 summary · saved ~3k" });
		expect(noticeMeta("[/compact] ✦ compacted · 11 rounds → 1 summary · saved ~3k")).toEqual({ label: "COMPACTED", sentence: "11 rounds → 1 summary · saved ~3k" });
	});
});
