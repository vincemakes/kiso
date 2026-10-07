/**
 * The main-sync round, part two (owner, 2026-09-30): #203's four tiers and
 * the don't-ask switch, drawn the Graphite way. The switch is not a tier:
 * it has its own chip on the bar and its own confirmation row.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Body } from "../src/compositor.js";
import { cellComponent, visibleWidth } from "../src/components.js";
import { palette, setGround } from "../src/lines.js";
import { statusBar, type BarInput } from "../src/status.js";

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const CTX = { spinnerI: 0, now: 0, height: 24 };
const BAR: BarInput = { mode: "default", floorOff: false, model: "deepseek-flash", ctx: null, tokPerSec: null, branch: "feat/tui", folder: "~/code/kiso" };

let tty: boolean | undefined;
beforeEach(() => {
	tty = process.stdout.isTTY;
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	delete process.env.NO_COLOR;
	setGround("light");
});
afterEach(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
	setGround("unknown");
});

describe("the bar", () => {
	it("the switch is a gold chip of its own beside the tier's, only while it is on", () => {
		const p = palette();
		const on = statusBar({ ...BAR, dontAsk: true }, 100, null);
		expect(on).toContain(`${p.gold}${p.washDone} don't ask ${p.washEnd}`);
		expect(plain(on)).toMatch(/^ default {4}don't ask /); // two chips, each padded, two cells apart
		expect(plain(statusBar(BAR, 100, null))).not.toContain("don't ask");
	});

	it("full access keeps the failure colour; the switch's chip stays gold beside it", () => {
		const p = palette();
		const row = statusBar({ ...BAR, mode: "full access", modeAlert: true, dontAsk: true }, 100, null);
		expect(row.startsWith(`${p.fail}${p.washDone} full access ${p.washEnd}`)).toBe(true);
		expect(row).toContain(`${p.gold}${p.washDone} don't ask `);
	});

	it("off a known ground it is words: `▸ default · don't ask`", () => {
		setGround("unknown");
		expect(plain(statusBar({ ...BAR, dontAsk: true }, 100, null))).toMatch(/^▸ default · don't ask · \/mode to switch/);
	});

	it("invariant ①: the bar fits with the chip, W 20..200, three grounds", () => {
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (let W = 20; W <= 200; W += 1) expect(visibleWidth(statusBar({ ...BAR, mode: "full access", modeAlert: true, dontAsk: true }, W, null)), `${g} W=${W}`).toBeLessThanOrEqual(W);
		}
	});
});

describe("the rows", () => {
	const body = (active: boolean): { b: Body; writes: string[] } => {
		const writes: string[] = [];
		return { b: new Body({ active: () => active, height: () => 24, width: () => 80, editCol: () => 1, write: (s) => writes.push(s) }), writes };
	};

	it("MODE names the tier; full access (the old bypass) is red", () => {
		const p = palette();
		const rows = cellComponent({ kind: "notice", text: "mode → full access", done: true, label: "MODE", sentence: "default → full access", mark: { text: "full access", tone: "fail" }, stacked: true } as never).render(80, CTX);
		expect(plain(rows[0]!)).toBe("  MODE  default → full access");
		expect(rows[0]).toContain(`${p.bold}${p.red}full access${p.reset}`);
	});

	it("DON'T ASK is a row of its own, the label gold, the new state bold", () => {
		const p = palette();
		const rows = cellComponent({ kind: "notice", text: "don't ask → on", done: true, label: "DON'T ASK", sentence: "off → on", mark: { text: "on", tone: "ink" }, stacked: true } as never).render(80, CTX);
		expect(plain(rows[0]!)).toBe("  DON'T ASK  off → on");
		expect(rows[0]!.startsWith(`  ${p.bold}${p.gold}DON'T ASK${p.reset}`)).toBe(true);
	});

	it("a pipe prints #203's words, byte for byte", () => {
		const { b, writes } = body(false);
		b.dontAskNotice("don't ask → off", false);
		b.modeNotice("mode → full access", "default", "full access");
		expect(writes.join("")).toBe("don't ask → off\nmode → full access\n");
	});
});
