/**
 * Graphite, the compaction round (owner, 2026-10-06) — the compacting row
 * (in a run and under /compact): its progress in the status bar's own `▆`
 * cells on a known ground (`▰▱` drew tiny in Menlo), the glyphs off one;
 * one round is a round; and a row whose fact carries colour is measured
 * without it.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { compactingStatus, composeRow } from "../src/index.js";
import { palette, setGround } from "../src/lines.js";

const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
beforeAll(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => setGround("unknown"));

describe("the compacting row's progress", () => {
	it("on a known ground: six ▆ cells, the filled ones ink2, the rest the track colour", () => {
		for (const g of ["light", "dark"] as const) {
			setGround(g);
			const p = palette();
			const row = compactingStatus("✦", 42, 180_000, 3, undefined, null, { produced: 16_000, budget: 32_000, reasoningUnseen: false }, "auto");
			expect(plain(row)).toBe("✦ compacting · auto · 42 rounds · ~180k → ▆▆▆▆▆▆ 16k/32k · 3s");
			expect(row).toContain(`${p.ink2}▆▆▆${p.track}▆▆▆${p.fgEnd}`);
			expect(row).not.toMatch(/[▰▱]/);
		}
	});

	it("off a known ground the glyphs carry the fill, as before", () => {
		const row = compactingStatus("✦", 42, 180_000, 3, undefined, null, { produced: 16_000, budget: 32_000, reasoningUnseen: false }, "auto");
		expect(row).toBe("✦ compacting · auto · 42 rounds · ~180k → ▰▰▰▱▱▱ 16k/32k · 3s");
	});

	it("one round is a round", () => {
		expect(compactingStatus("✦", 1, 30_100, 1, undefined, null, null, "auto")).toBe("✦ compacting · auto · 1 round · ~30.1k tokens · 1s");
	});

	it("a row is measured without its colour codes: the cells never cost a hint its place", () => {
		setGround("dark");
		const progress = { produced: 16_000, budget: 32_000, reasoningUnseen: true };
		const full = plain(compactingStatus("✦", 42, 180_000, 3, undefined, null, progress, "auto"));
		expect(full).toContain("incl. unstreamed reasoning");
		// composed at exactly its visible width the hint stays — counting the
		// colour codes as cells would have dropped it
		expect(plain(compactingStatus("✦", 42, 180_000, 3, full.length, null, progress, "auto"))).toBe(full);
		// one cell less and the hint is the first to go, as on a plain row
		expect(plain(compactingStatus("✦", 42, 180_000, 3, full.length - 1, null, progress, "auto"))).not.toContain("incl. unstreamed reasoning");
		// composeRow's own measure: a coloured fact counts its cells only
		const coloured = `${palette().ink2}abc${palette().fgEnd}`;
		expect(composeRow("x", [{ kind: "fact", text: coloured }, { kind: "hint", text: "keep me" }], 18)).toBe(`x · ${coloured} · keep me`);
	});
});
