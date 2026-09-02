/**
 * DC-40 — the first frame scrolls the shell's screen away instead of
 * painting over it.
 *
 * At launch the terminal's rows 1..r are the shell's: its prompt, the
 * launch command, the tail of whatever ran before. The first frame is
 * the full-redraw path and addresses rows 1..H absolutely, so it
 * overwrote them — gone, not in the scrollback. Measured on Apple
 * Terminal with 0.20.3: 37 of 60 shell lines survived, and every line
 * that was ON SCREEN when kiso started was among the lost.
 *
 * The fix is H line feeds from the shell's cursor, emitted BEFORE the
 * entry reset. The order is the whole fix: `ESC[r` (DECSTBM) homes the
 * cursor, so feeds emitted AFTER it start from row 1 and scroll ONE row
 * — 1/20 on Apple Terminal, measured, with an otherwise byte-identical
 * frame. Feeds BEFORE it scroll r rows: 20/20.
 *
 * The instrument here (VtScrollback) models the homing, so G2 is RED on
 * the wrong order. The house emulators did not model it and passed the
 * wrong order green — the trap REL-0152-D20 named, met again. The
 * acceptance surface for this class remains the real terminal's own
 * buffer (kiso-doc/tui-recon-2026-09-02/dc40-probe/, AppleScript
 * `history of selected tab`); this file pins the bytes and the emulated
 * consequence, both of which discriminate the two orders.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { VtScrollback } from "./vt-scrollback.js";

const H = 24;
const W = 80;
const RESET = "\x1b[r\x1b[?69l\x1b[?7h\x1b[?25l";
const FEEDS = "\n".repeat(H);

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: H, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: W, configurable: true });
});
afterEach(() => {
	vi.useRealTimers();
	delete (process.stdout as { isTTY?: boolean }).isTTY;
	delete (process.stdout as { rows?: number }).rows;
	delete (process.stdout as { columns?: number }).columns;
});

/** The first frame's bytes — everything the dock writes on entry. */
function entered(): string {
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	body.enter();
	vi.advanceTimersByTime(60);
	return writes.join("");
}

/** The shell's screen at launch: r−1 rows of content, the launch command,
 *  the cursor on the fresh line below it (column 1). */
const SHELL = Array.from({ length: 20 }, (_, i) => `pre ${String(i + 1).padStart(2, "0")} shell-history-line`);
const LAUNCH = "$ kiso";

function shellScreen(): VtScrollback {
	const vt = new VtScrollback(W, H);
	vt.feed(`${SHELL.map((l) => `${l}\r\n`).join("")}${LAUNCH}\r\n`);
	return vt;
}

function survivors(lines: readonly string[]): string[] {
	return SHELL.filter((needle) => lines.some((l) => l === needle));
}

describe("DC-40 — G1: the first frame's bytes", () => {
	it("emits exactly H line feeds BEFORE the entry reset, and no cursor addressing before the feeds", () => {
		const bytes = entered();
		const reset = bytes.indexOf(RESET);
		expect(reset, "the entry reset is present").toBeGreaterThanOrEqual(0);
		const before = bytes.slice(0, reset);
		expect(before.split("\n").length - 1, "line feeds before the reset").toBe(H);
		expect(before, "no CUP before the feeds — an addressed write would land on the shell's rows").not.toMatch(/\x1b\[\d*(;\d*)?H/);
		expect(before, "no erase before the feeds").not.toMatch(/\x1b\[\d*[JK]/);
	});

	it("the feeds are contiguous and directly precede the reset — nothing moves the cursor between them", () => {
		const bytes = entered();
		expect(bytes).toContain(FEEDS + RESET);
	});

	it("the reset still precedes the frame (REL-0152-D19), and the frame still addresses rows absolutely", () => {
		const bytes = entered();
		const reset = bytes.indexOf(RESET);
		const frame = bytes.indexOf("\x1b[?7l");
		expect(reset).toBeLessThan(frame);
		expect(bytes.slice(frame)).toContain("\x1b[1;1H");
	});

	it("no feeds after the reset — the D20 objection (H BLANK rows pushed) was feeds from a homed cursor", () => {
		const bytes = entered();
		const after = bytes.slice(bytes.indexOf(RESET) + RESET.length);
		// the frame itself scrolls nothing on entry: the committed height is 0
		expect(after.split("\n").length - 1).toBe(0);
	});
});

describe("DC-40 — G2: the shell's screen survives, in the scrollback", () => {
	it("every shell row is in the scrollback, none on screen, none lost, none twice", () => {
		const vt = shellScreen();
		vt.feed(entered());
		expect(survivors(vt.scrollback), "shell rows in the scrollback").toEqual(SHELL);
		expect(vt.scrollback, "the launch command scrolled away too").toContain(LAUNCH);
		const screen = Array.from({ length: H }, (_, k) => vt.line(k + 1));
		expect(survivors(screen), "no shell row left on screen").toEqual([]);
		for (const needle of SHELL) {
			expect(vt.allLines().filter((l) => l === needle).length, `${needle} reachable exactly once`).toBe(1);
		}
	});

	it("at most ONE blank row enters the scrollback — the cursor's own line, not a screenful", () => {
		// REL-0152-D20 declined a variant that pushed up to H blank rows
		// and broke TUI2-R2pre's blank-share gate. Feeding from the shell's
		// cursor pushes the shell's rows and the blank line under them.
		const vt = shellScreen();
		vt.feed(entered());
		expect(vt.scrollback.filter((l) => l === "").length).toBeLessThanOrEqual(1);
	});

	it("the frame owns rows 1..H afterwards — the model's row 0 IS the terminal's row 1", () => {
		const vt = shellScreen();
		const bytes = entered();
		vt.feed(bytes);
		// the first row the frame painted (after the reset) is on screen row 1
		const frame = bytes.slice(bytes.indexOf(RESET));
		const firstPainted = /\x1b\[1;1H\x1b\[0K([^\x1b\n\r]*)/.exec(frame)?.[1] ?? "";
		expect(vt.line(1)).toBe(firstPainted.replace(/\s+$/, ""));
	});

	it("DISCRIMINATOR — the same bytes with the feeds AFTER the reset lose the shell's screen (1 of 20, as measured)", () => {
		// `ESC[r` homes the cursor; feeds from row 1 move H−1 rows and
		// scroll one. The frame then paints over the other nineteen. This
		// is the order that was built first, passed every house emulator,
		// and scored 1/20 on Apple Terminal.
		const bytes = entered();
		expect(bytes).toContain(FEEDS + RESET);
		const wrong = bytes.replace(FEEDS + RESET, RESET + FEEDS);
		const vt = shellScreen();
		vt.feed(wrong);
		expect(survivors(vt.allLines())).toEqual([SHELL[0]]);
	});
});

describe("DC-40 — the instrument: VtScrollback models DECSTBM's cursor homing", () => {
	it("`ESC[r` puts the cursor at row 1, column 1", () => {
		const vt = new VtScrollback(W, H);
		vt.feed("\x1b[10;5HX\x1b[rY");
		expect(vt.line(10)).toBe("    X");
		expect(vt.line(1)).toBe("Y");
	});

	it("`ESC[t;b r` homes too — the margins are not modelled, the homing is", () => {
		const vt = new VtScrollback(W, H);
		vt.feed("\x1b[10;5HX\x1b[5;20rY");
		expect(vt.line(1)).toBe("Y");
	});

	it("feeds after a homing scroll ONE row; feeds before it scroll r", () => {
		const a = shellScreen(); // cursor at row 22
		a.feed(RESET + FEEDS);
		expect(a.scrollback.length, "homed first: one row").toBe(1);
		const b = shellScreen();
		b.feed(FEEDS + RESET);
		expect(b.scrollback.length, "feeds first: the shell's 22 rows").toBe(22);
	});
});
