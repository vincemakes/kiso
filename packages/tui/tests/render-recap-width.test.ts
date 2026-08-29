/**
 * R3g — the recap is ONE physical row, at any width.
 *
 * It was the one row on the screen nobody measured: `renderRecap`
 * joined its segments and wrote them raw, so a turn with enough to say
 * produced a line longer than the terminal, the terminal wrapped it,
 * and the second physical row was a fragment ("ft ~100%") matching no
 * cell format — which is exactly what the v2d interleaving lint reads
 * as two cells bleeding into each other.
 *
 * It went unnoticed because the old terms were short. R3g's verb+noun
 * phrasing ("listed 1 directory · ran 1 shell command") made an
 * 80-column wrap ordinary rather than rare, and the lint caught it.
 */

import { describe, expect, it } from "vitest";
import { visibleWidth } from "@vincemakes/kiso-tui-cells/width";
import { renderRecap } from "../src/render.js";

const stats = (width: number | undefined) => ({
	seconds: 37,
	tools: 12,
	edits: 2,
	byTool: [
		["read_file", 8],
		["list_dir", 3],
		["shell", 4],
		["search_text", 6],
	] as [string, number][],
	usage: { known: true, in: 128_000, out: 4_200, cache: 96_000 },
	missed: 2_400,
	ctxLeftPct: 41,
	...(width !== undefined ? { width } : {}),
});

describe("R3g — the recap never wraps", () => {
	for (const W of [40, 60, 80, 100, 200]) {
		it(`W=${W}: one row, within the width`, () => {
			const out = renderRecap(stats(W) as never);
			expect(out.endsWith("\n")).toBe(true);
			const rows = out.slice(0, -1).split("\n");
			expect(rows).toHaveLength(1);
			expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(W);
		});
	}

	it("a turn with plenty to say is CUT, and says so with the honest …", () => {
		const out = renderRecap(stats(60) as never).slice(0, -1);
		expect(out).toContain("…");
		expect(out).toContain("took 37s"); // the head survives the cut
	});

	it("a degenerate width is not a width — 0 columns (a PTY with no winsize) never cuts", () => {
		// The gate that caught this: `process.stdout.columns ?? 80` keeps
		// the 0 a winsize-less PTY reports, because 0 is not nullish, and
		// the recap came out as `✦ t…`.
		const out = renderRecap(stats(0) as never).slice(0, -1);
		expect(out).toContain("took 37s");
		expect(out).not.toContain("…");
	});

	it("no width given → the historical bytes, uncut (the callers that render into no terminal)", () => {
		const out = renderRecap(stats(undefined) as never).slice(0, -1);
		expect(out).not.toContain("…");
		expect(visibleWidth(out)).toBeGreaterThan(80);
	});
});
