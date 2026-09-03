/**
 * The CSI 997 colour-scheme report, and why the ground needed a second
 * way to learn what the terminal is.
 *
 * OSC 11 asks the terminal for its BACKGROUND COLOUR and kiso computes
 * the ground from that colour's luminance (§3 rung 2). It is an
 * inference, and it is contingent: a terminal that does not answer
 * leaves the ground `unknown`, and `unknown` means the wash degrades —
 * which, since the slab arrived, is the difference between a command
 * block that is a surface and one that is not.
 *
 * `CSI ? 996 n` asks a different and better question: the terminal
 * REPORTS its own colour scheme, `CSI ? 997 ; 1 n` for dark and
 * `; 2 n` for light. No luminance, no threshold, no inference — the
 * terminal says which it is. Where both answer, 997 wins, because one
 * of them is the terminal's own account of itself and the other is
 * kiso's reading of a number it was given.
 *
 * THE RED THIS FILE WAS WRITTEN AS: the reply is a CSI, and `#csi`
 * recognises a fixed set of finals. `?997;1` with final `n` matched
 * none of them, so it reached the end of that method and was dropped in
 * silence — the report arrived, and nothing in the product could hear
 * it. `onColorScheme` did not exist; the first case below failed with
 * "editor.onColorScheme is not a function", which is the honest shape
 * of "this reply cannot reach the ground today".
 */

import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";

const enc = (s: string): Buffer => Buffer.from(s, "utf8");

function editor(): { e: Editor; seen: string[]; osc: string[]; line: () => string } {
	const e = new Editor(() => {});
	const seen: string[] = [];
	const osc: string[] = [];
	e.onColorScheme((s) => seen.push(s));
	e.onOsc((b) => osc.push(b));
	return { e, seen, osc, line: () => e.line() };
}

describe("CSI 997 — the terminal's own account of its colour scheme", () => {
	it("`CSI ? 997 ; 1 n` is DARK", () => {
		const { e, seen } = editor();
		e.feed(enc("\x1b[?997;1n"));
		expect(seen).toEqual(["dark"]);
	});

	it("`CSI ? 997 ; 2 n` is LIGHT", () => {
		const { e, seen } = editor();
		e.feed(enc("\x1b[?997;2n"));
		expect(seen).toEqual(["light"]);
	});

	it("the report never reaches the draft — a reply typed into the buffer is the DC-7 defect", () => {
		const { e, seen, line } = editor();
		e.feed(enc("hello"));
		e.feed(enc("\x1b[?997;1n"));
		e.feed(enc(" there"));
		expect(line()).toBe("hello there");
		expect(seen).toEqual(["dark"]);
	});

	it("it does NOT pollute onOsc — the two reports are different channels", () => {
		const { e, seen, osc } = editor();
		e.feed(enc("\x1b[?997;2n"));
		expect(seen).toEqual(["light"]);
		expect(osc).toEqual([]);
	});

	it("a NEIGHBOURING report is not mistaken for one: only 997, only 1 or 2", () => {
		const { e, seen } = editor();
		// a device-status report (CSI 5n / CSI 0n) and a cursor-position
		// report share the `n`/`R` finals; a 996 echo and an out-of-range
		// parameter are not colour schemes either.
		for (const csi of ["\x1b[0n", "\x1b[?996n", "\x1b[?997;3n", "\x1b[?997n", "\x1b[997;1n"]) e.feed(enc(csi));
		expect(seen).toEqual([]);
	});

	it("a report split across two chunks still arrives — the #pending CSI resume", () => {
		const { e, seen } = editor();
		e.feed(enc("\x1b[?99"));
		e.feed(enc("7;1n"));
		expect(seen).toEqual(["dark"]);
	});
});
