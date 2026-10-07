/**
 * Graphite, the sheets round (owner, 2026-10-06) — the read-only sheets
 * take `/status`'s shape: a sheet over the input, named by its band, its
 * rows at the content edge in measured columns, closed by
 * `esc closes · typing goes to the input` — read, then typed past.
 *
 *   - `/context`: the band names the total; the bar's own meter (one rule
 *     with the status bar's, so the two cannot disagree) and when
 *     compaction happens; the surfaces as a table; no blank rows.
 *   - the keys sheet closes like every sheet (what is typed is typed).
 *   - `/help` opens the command list (`openCommands`).
 *
 * The keys sheet's rows are pinned in tui-cells' tui2-r1-keys-sheet; the
 * `/skills` sheet in the CLI's graphite-skills-sheet; the wiring through
 * the real binary in graphite-sheets-pty.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "../src/editor.js";
import { contextSheetRows, contextUnavailableSheetRows, meterCells, type ContextLedger } from "../src/context-ledger.js";
import { ctxMeter } from "../src/status.js";
import { palette, setGround } from "../src/lines.js";
import { visibleWidth } from "../src/components.js";
import { SHEET_CLOSE } from "@vincemakes/kiso-tui-cells/strings";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");

const LEDGER: ContextLedger = { window: 200_000, systemPrompt: 431, systemBase: 431, appends: 0, toolTable: 2_100, tools: 10, skillsIndex: 77, skills: 3, envelope: 11, messages: 52, turns: 1 };
const TIERS = { soft: 0.5, hard: 0.8 };
const at = (share: number): ContextLedger => ({ ...LEDGER, messages: Math.round(share * LEDGER.window) - (LEDGER.systemPrompt + LEDGER.toolTable + LEDGER.skillsIndex + LEDGER.envelope) });

// the palette is a TTY's: off a terminal every tone is "" and a meter test
// would pass on nothing
beforeAll(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => setGround("unknown"));

describe("the /context sheet", () => {
	it("the band names the total; the meter and when compaction happens; the surfaces as a table; free; the closing row", () => {
		setGround("light");
		const rows = contextSheetRows(LEDGER, TIERS, 80).map(plain);
		expect(rows[0]).toMatch(/^─── context · 2\.7k of 200k · 1% ─+$/);
		expect(rows[1]).toBe(`  ${"▆".repeat(10)}  compaction past 50% at a phase end, past 80% at once`);
		expect(rows.slice(2)).toEqual([
			"  system prompt     431   base 431",
			"  tool table       2.1k   10 tools",
			"  skills index       77   3 skills, tier-1 lines only",
			"  envelope           11",
			"  messages           52   1 turn",
			"  free           197.3k",
			`  ${SHEET_CLOSE}`,
		]);
	});

	it("no blank rows — the printed form spent a cell per row and came out double-spaced", () => {
		setGround("light");
		expect(contextSheetRows(LEDGER, TIERS, 80).filter((r) => plain(r).trim() === "")).toEqual([]);
	});

	it("the meter is the bar's: ink2 below the soft tier, gold to the hard one, the failure colour past it", () => {
		setGround("light");
		const p = palette();
		expect([p.ink2, p.gold, p.fail, p.track].includes(""), "the palette is on").toBe(false);
		for (const [share, tone] of [
			[0.3, p.ink2],
			[0.6, p.gold],
			[0.9, p.fail],
		] as const) {
			const meter = contextSheetRows(at(share), TIERS, 80)[1]!;
			expect(meter, `${share}`).toContain(`${tone}▆`);
			// ONE rule: the same cells the status bar draws for the same share
			expect(ctxMeter({ used: share, soft: TIERS.soft, hard: TIERS.hard } as never)).toContain(meterCells(share, TIERS.soft, TIERS.hard));
			expect(meter).toContain(meterCells(share, TIERS.soft, TIERS.hard));
		}
	});

	it("without a known window there is no compaction note; off a known ground, no cells — the band still says the share", () => {
		setGround("light");
		expect(plain(contextSheetRows(LEDGER, null, 80)[1]!)).toBe(`  ${"▆".repeat(10)}`);
		setGround("unknown");
		const rows = contextSheetRows(LEDGER, TIERS, 80).map(plain);
		expect(rows[0]).toContain("context · 2.7k of 200k · 1%");
		expect(rows[1]).toBe("  compaction past 50% at a phase end, past 80% at once");
	});

	it("before any request: the band says there is no ledger yet, and what produces one", () => {
		setGround("light");
		const rows = contextUnavailableSheetRows("the ledger is written per request — run a turn, then ask again", 80).map(plain);
		expect(rows[0]).toMatch(/^─── context · no ledger yet ─+$/);
		expect(rows.slice(1)).toEqual(["  the ledger is written per request — run a turn, then ask again", `  ${SHEET_CLOSE}`]);
	});

	it("every row fits, W 20..160, on three grounds; no bare ESC", () => {
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (let W = 20; W <= 160; W += 1) {
				for (const r of [...contextSheetRows(LEDGER, TIERS, W), ...contextUnavailableSheetRows("run a turn, then ask again", W)]) {
					expect(visibleWidth(r), `${g} W=${W}`).toBeLessThanOrEqual(W);
					expect(r.replace(/\x1b\[[0-9;]*m/g, ""), `${g} W=${W}`).not.toContain("\x1b");
				}
			}
		}
	});
});

describe("the editor — /help opens the command list", () => {
	let editor: Editor;
	beforeEach(() => {
		vi.useFakeTimers();
		editor = new Editor(() => {});
	});
	afterEach(() => vi.useRealTimers());

	it("on an empty composer it is the band a typed `/` opens", () => {
		editor.openCommands();
		expect(editor.line()).toBe("/");
		expect(editor.menuState()).not.toBeNull();
		// typing filters it, as it does after a typed `/`
		editor.feed(enc("cont"));
		expect(editor.menuState()!.items.map((i) => i.name)).toContain("/context");
	});

	it("a line already being written is the person's: nothing moves", () => {
		editor.feed(enc("half a sentence"));
		editor.openCommands();
		expect(editor.line()).toBe("half a sentence");
		expect(editor.menuState()).toBeNull();
	});
});
