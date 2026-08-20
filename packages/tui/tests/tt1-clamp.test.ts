/**
 * TT-1B — finding TUI2-MD-1 (RED before GREEN): a commit burst taller
 * than the screen loses rows from the terminal's scrollback.
 *
 * The mechanism: #drawFull stages leaving rows at their old screen rows
 * before the LF scroll. Rows whose position lands past H are CLAMPED BY
 * THE TERMINAL (CUP pins to the last row) — the bytes are emitted, the
 * content lands nowhere, and the scroll pushes whatever the pile left.
 * Measured on 0.11.0 (the finding): H=20 lost 12 rows of ~25 at W=80.
 * Block-freeze made the bursts rarer, not the mechanism sound.
 *
 * The instrument is vt-scrollback (the house emulator drops scrolled
 * rows on the floor — no existing gate can SEE this class). The claim:
 * after a burst commit of N > H lines, every line is reachable — in the
 * scrollback or on the screen — and none entered the scrollback twice.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/index.js";
import { VtScrollback } from "./vt-scrollback.js";

function makeBody(opts: { W?: number; H?: number } = {}) {
	let W = opts.W ?? 80;
	let H = opts.H ?? 24;
	const writes: string[] = [];
	const body = new Body({
		active: () => true,
		height: () => H,
		width: () => W,
		editCol: () => 1,
		write: (s) => writes.push(s),
	});
	return {
		body,
		writes,
		tick: () => vi.advanceTimersByTime(16),
		setSize: (w: number, h: number) => {
			W = w;
			H = h;
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
});

describe("TT-1B — TUI2-MD-1: the over-tall commit burst keeps every row (the scrollback replay)", () => {
	it("40 list lines force-committed on a 12-row screen: none lost, none doubled", () => {
		const { body, writes, tick, setSize } = makeBody({ W: 40, H: 24 });
		body.enter();
		// one OPEN list block — one row per item, no reflow (the A8b
		// fixture's own idiom); 40 rows dwarf both heights
		body.textAppend(Array.from({ length: 40 }, (_, i) => `- burst line ${String(i).padStart(2, "0")}`).join("\n"));
		tick();
		// the winch to 12 rows force-commits the block AT the resize frame —
		// the whole 40-line burst leaves in ONE frame on a 12-row screen
		const vt = new VtScrollback(40, 24);
		vt.feed(writes.join(""));
		writes.length = 0;
		setSize(40, 12);
		vt.resize(40, 12);
		body.onResize();
		vt.feed(writes.join(""));

		const reachable = vt.allLines();
		const missing: string[] = [];
		for (let i = 0; i < 40; i += 1) {
			const needle = `• burst line ${String(i).padStart(2, "0")}`;
			if (!reachable.some((l) => l.includes(needle))) missing.push(needle);
		}
		expect(missing).toEqual([]); // TUI2-MD-1: today the clamp pile drops the early rows

		// and the R2pre-1 axis on the same replay: no line entered the
		// scrollback twice (the duplicate class — bounded today, gated here)
		const doubled: string[] = [];
		for (let i = 0; i < 40; i += 1) {
			const needle = `• burst line ${String(i).padStart(2, "0")}`;
			if (vt.scrollback.filter((l) => l.includes(needle)).length > 1) doubled.push(needle);
		}
		expect(doubled).toEqual([]);
	});
});
