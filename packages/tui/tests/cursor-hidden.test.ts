/**
 * REL-0161 — the hidden-cursor contract.
 *
 * Terminal.app's "Automatically Mark Prompt Lines" infers a prompt on
 * any line where bracketed paste is armed AND the hardware cursor is
 * visible (established by the owner's C-probe, 2026-08-27: hiding the
 * cursor stopped the marks — including the shell's own). The composer
 * met both conditions; the reference implementation is immune because
 * it keeps the hardware cursor hidden and draws its own.
 *
 * The contract kiso adopts, gated here:
 *
 *  1. the entry reset ESTABLISHES `?25l` — it also repairs a killed
 *     predecessor straight into the desired state;
 *  2. no frame ever emits `?25h`: the hardware cursor stays hidden for
 *     the session's life. It still PARKS at the marker cell — the IME
 *     anchor is the cursor's position, not its visibility;
 *  3. the composer draws its own cursor: the cell at the marker
 *     renders inverse (SGR 7 … 27). A wide (CJK) glyph inverts whole;
 *     the end-of-line cursor is an inverse space taken out of the pad,
 *     so the row's width is exactly W either way;
 *  4. `editor.exit()` restores `?25h` — the one place kiso hands the
 *     terminal back. (`kill -9` leaves the cursor hidden — the same
 *     exposure the reference implementation accepts; the entry repair
 *     covers the next kiso.)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { Editor } from "../src/editor.js";

const enc = (s: string) => new TextEncoder().encode(s);

function makeBody(opts: { W?: number; H?: number; termProgram?: string } = {}) {
	const W = opts.W ?? 80;
	const H = opts.H ?? 24;
	const writes: string[] = [];
	const body = new Body({
		active: () => true,
		height: () => H,
		width: () => W,
		editCol: () => 1,
		write: (s) => writes.push(s),
		termProgram: opts.termProgram ?? "Apple_Terminal",
	});
	return { body, writes, tick: () => vi.advanceTimersByTime(50) };
}

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});
afterEach(() => {
	vi.useRealTimers();
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

describe("REL-0161 ① — the entry reset establishes a hidden cursor", () => {
	for (const termProgram of ["Apple_Terminal", "iTerm.app"]) {
		it(`${termProgram}: the first frame's reset ends in ?25l, and no frame shows the cursor`, () => {
			const { body, writes, tick } = makeBody({ termProgram });
			body.bindInput(() => ({ line: "", cursor: 0 }), "› ");
			body.enter();
			tick();
			const all = writes.join("");
			expect(all).toContain("\x1b[r\x1b[?69l\x1b[?7h\x1b[?25l");
			expect(all).not.toContain("\x1b[?25h");
		});
	}
});

describe("REL-0161 ② — steady frames never show the cursor", () => {
	for (const termProgram of ["Apple_Terminal", "iTerm.app"]) {
		it(`${termProgram}: streaming and committing frames carry no ?25h`, () => {
			const { body, writes, tick } = makeBody({ termProgram });
			body.bindInput(() => ({ line: "hi", cursor: 2 }), "› ");
			body.enter();
			tick();
			body.textAppend("streamed prose");
			tick();
			body.raw(["a committed line"]);
			tick();
			expect(writes.join("")).not.toContain("\x1b[?25h");
		});
	}
});

describe("REL-0161 ③ — the composer draws its own cursor", () => {
	it("mid-line: the cell at the cursor renders inverse", () => {
		const { body, writes, tick } = makeBody();
		body.bindInput(() => ({ line: "ab", cursor: 1 }), "› ");
		body.enter();
		tick();
		expect(writes.join("")).toContain("› a\x1b[7mb\x1b[27m");
	});

	it("end of line: an inverse space, taken out of the pad (the wall still lands)", () => {
		const { body, writes, tick } = makeBody();
		body.bindInput(() => ({ line: "ab", cursor: 2 }), "› ");
		body.enter();
		tick();
		const all = writes.join("");
		expect(all).toContain("› ab\x1b[7m \x1b[27m");
		// the row still carries its right wall — the inverse space came
		// out of the pad, not on top of it
		expect(all).toMatch(/› ab\x1b\[7m \x1b\[27m\x1b\[2m *│/);
	});

	it("a wide (CJK) glyph inverts whole", () => {
		const { body, writes, tick } = makeBody();
		body.bindInput(() => ({ line: "\u4f60\u597d", cursor: 0 }), "› ");
		body.enter();
		tick();
		expect(writes.join("")).toContain("› \x1b[7m\u4f60\x1b[27m\u597d");
	});

	it("an empty composer still shows a cursor: the inverse space after the lead", () => {
		const { body, writes, tick } = makeBody();
		body.bindInput(() => ({ line: "", cursor: 0 }), "› ");
		body.enter();
		tick();
		expect(writes.join("")).toContain("› \x1b[7m \x1b[27m");
	});

	it("the marker CHA still parks the hardware cursor at the drawn cell (the IME anchor)", () => {
		const { body, writes, tick } = makeBody();
		body.bindInput(() => ({ line: "abc", cursor: 1 }), "› ");
		body.enter();
		tick();
		// wallL (2) + lead (2) + cursor (1) + 1 → column 6, exactly the
		// cell the inverse glyph occupies
		expect(writes.join("")).toContain("\x1b[6G");
	});
});

describe("REL-0161 ④ — exit() hands the cursor back", () => {
	it("editor.exit() writes ?25h alongside its paste-mode restore", () => {
		if (typeof (process.stdin as { setRawMode?: unknown }).setRawMode !== "function") {
			(process.stdin as unknown as { setRawMode: (b: boolean) => void }).setRawMode = () => {};
		}
		const out: string[] = [];
		const spy = vi.spyOn(process.stdout, "write").mockImplementation(((s: string | Uint8Array) => {
			out.push(typeof s === "string" ? s : new TextDecoder().decode(s));
			return true;
		}) as typeof process.stdout.write);
		try {
			const editor = new Editor(() => {});
			editor.enter();
			editor.exit();
		} finally {
			spy.mockRestore();
		}
		const all = out.join("");
		expect(all).toContain("\x1b[?2004l");
		expect(all).toContain("\x1b[?25h");
	});
});
