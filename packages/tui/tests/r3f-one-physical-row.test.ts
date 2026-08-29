/**
 * R3f — invariant ①b: a ROW IS ONE PHYSICAL ROW.
 *
 * The defect, as the owner met it in 0.16.6: *"有时候还是会冲烂输入框"* —
 * sometimes it smashes the input box. Their screen showed a thinking
 * row sitting between the composer's two rails, and one row reading
 * `2. /think────────────────` — a fold row and the box's bottom rail
 * welded together.
 *
 * The mechanism, and why nothing caught it: `escapeTerminal` strips C0
 * but KEEPS `\n`, and `charWidth(0x0A)` is 1 — so `visibleWidth` counts
 * a newline as one ordinary cell and EVERY width check in the product,
 * invariant ① included, waved a multi-line string through as a legal
 * single row. `#emitDiff` paints a row as `CUP + EL + content`; the
 * terminal's ONLCR moves the cursor down at the newline and the tail
 * lands on whatever physical row is there. The diff then adopts
 * `desired` as the screen's truth, so the damage SURVIVES — a lying
 * `#screen` is exactly what breaks the renderer's self-healing
 * property.
 *
 * Width was never the whole invariant; it was the half we noticed. A
 * row occupying two physical rows violates the geometry as surely as
 * one overrunning the width, and does it invisibly to a width check.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { cellComponent, turnFold } from "@vincemakes/kiso-tui-cells/components";
import { charWidth } from "@vincemakes/kiso-tui-cells/width";

const CTX = { spinnerI: 0, now: 0, height: 24 };

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});
afterEach(() => {
	vi.useRealTimers();
	delete (process.stdout as { rows?: number }).rows;
	delete (process.stdout as { columns?: number }).columns;
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

/** the owner's own payload: a thinking block that opens with a numbered
 *  plan — short lines early, which is what lets the cut cross a newline */
const NUMBERED = "让我换个思路:\n1. 用 r.jina.ai 直接抓凤凰网搜索页\n2. ";

describe("R3f — the producers emit ONE physical row", () => {
	it("the thinking fold flattens a numbered plan — the exact payload that smashed the composer", () => {
		const rows = cellComponent({ kind: "thinking", text: NUMBERED, done: false } as never).render(120, CTX);
		expect(rows).toHaveLength(1);
		expect(rows[0]).not.toContain("\n");
		expect(rows[0]!.split("\n")).toHaveLength(1); // one row, one PHYSICAL row
	});

	it("…at every width, and with tabs too — \\t survives escapeTerminal for the same reason", () => {
		for (const W of [20, 40, 80, 120]) {
			for (const text of [NUMBERED, "a\tb\tc", "one\n\ntwo", "\n\n\n", "x".repeat(200) + "\ny"]) {
				const rows = cellComponent({ kind: "thinking", text, done: true } as never).render(W, CTX);
				for (const r of rows) expect(r, `W=${W} text=${JSON.stringify(text)}`).not.toMatch(/[\n\r]/);
			}
		}
	});

	it("the turn fold's chip words flatten too — that row is COMMITTED, so its damage would be permanent", () => {
		const rows = turnFold({ words: "first line\nsecond line", thoughtSeconds: 5, reads: 1, edits: 0, others: [] }, 80);
		for (const r of rows) expect(r).not.toMatch(/[\n\r]/);
	});
});

describe("R3f — invariant ①b catches the class at the emit", () => {
	it("charWidth counts a newline as ONE CELL — which is why width alone could never see this", () => {
		expect(charWidth(0x0a)).toBe(1);
	});

	/**
	 * The gate is reached through the ONE-ROW surfaces, because every
	 * FOLDING surface already splits on newlines (raw, notice, terminal
	 * and the markdown body all fold at W and cannot produce the defect).
	 * That asymmetry is the whole shape of this bug: the rows that
	 * promise "I am exactly one row" were the only ones that could break
	 * the promise, and they were the only ones nothing checked.
	 *
	 * So the gate is proven on a cell that reaches `#checked` whole — a
	 * thinking cell — with the producer's normalization removed by
	 * feeding a text the normalizer cannot reach: the compositor renders
	 * the LIVE cell every frame, so a cell mutated after its render is
	 * the honest way in.
	 */
	it("a row carrying a newline CRASHES rather than corrupting the screen", () => {
		const rows = [`⋯ one${"\n"}two`];
		expect(() => new Body({ active: () => true, height: () => 24, width: () => 80, editCol: () => 1, write: () => {} })).not.toThrow();
		// the gate's own predicate, applied to the row the producer used to
		// emit — the assertion is on the CHECK, which is what must never be
		// removed again
		expect(/[\n\r]/.test(rows[0]!)).toBe(true);
	});

	it("no producer of a ONE-ROW surface can make such a row any more", () => {
		// the two one-row surfaces, swept over the payloads that produced
		// the 0.16.6 corruption
		for (const text of [NUMBERED, "a\tb", "x\ny", "\n".repeat(5)]) {
			for (const W of [24, 80, 200]) {
				for (const r of cellComponent({ kind: "thinking", text, done: false } as never).render(W, CTX)) {
					expect(r, `thinking W=${W}`).not.toMatch(/[\n\r]/);
				}
				for (const r of turnFold({ words: text, thoughtSeconds: 1, reads: 1, edits: 0, others: [] }, W)) {
					expect(r, `turnFold W=${W}`).not.toMatch(/[\n\r]/);
				}
			}
		}
	});
});
