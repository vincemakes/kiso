/**
 * DC-3 §1 — the ground, resolved as a pure function.
 *
 * Every colour decision in the palette needs one fact kiso has never
 * had: is the terminal light or dark. Nothing here does I/O — the OSC
 * answer arrives as a string and the environment arrives as fields, so
 * the ladder is testable without a terminal and the terminal work is
 * only plumbing.
 *
 * The ladder, first hit wins:
 *   1. an explicit answer (KISO_THEME)
 *   2. the terminal's OSC 11 answer
 *   3. COLORFGBG
 *   4. unknown — and unknown is a real answer, not a failure: it means
 *      the caller must use the mark that is correct on ANY ground.
 */

import { describe, expect, it } from "vitest";
import { groundFrom, parseOscColor, relativeLuminance, resolveGround } from "../src/ground.js";

describe("parseOscColor", () => {
	it("reads the four-digit form Apple Terminal answers with", () => {
		expect(parseOscColor("11;rgb:ffff/ffff/ffff")).toEqual({ r: 255, g: 255, b: 255 });
		expect(parseOscColor("11;rgb:0000/0000/0000")).toEqual({ r: 0, g: 0, b: 0 });
		expect(parseOscColor("11;rgb:1e1e/1e1e/1e1e")).toEqual({ r: 30, g: 30, b: 30 });
	});

	it("scales one- and two-digit components to eight bits", () => {
		expect(parseOscColor("11;rgb:f/f/f")).toEqual({ r: 255, g: 255, b: 255 });
		expect(parseOscColor("11;rgb:ff/80/00")).toEqual({ r: 255, g: 128, b: 0 });
	});

	it("takes the foreground answer too — the number is not hard-coded", () => {
		expect(parseOscColor("10;rgb:0000/0000/0000")).toEqual({ r: 0, g: 0, b: 0 });
	});

	it("returns null for anything it cannot read, rather than a guess", () => {
		for (const junk of ["", "11", "11;", "11;rgb:", "11;rgb:zz/zz/zz", "52;c;AAAA", "11;#ffffff"]) {
			expect(parseOscColor(junk), junk).toBeNull();
		}
	});
});

describe("relativeLuminance / groundFrom", () => {
	it("is the WCAG formula, not a channel average", () => {
		expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
		expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
		// green carries most of the weight — a pure green is far brighter
		// than a pure blue of the same channel value
		expect(relativeLuminance({ r: 0, g: 255, b: 0 })).toBeGreaterThan(relativeLuminance({ r: 0, g: 0, b: 255 }));
	});

	it("splits at half", () => {
		expect(groundFrom({ r: 255, g: 255, b: 255 })).toBe("light");
		expect(groundFrom({ r: 30, g: 30, b: 30 })).toBe("dark");
		expect(groundFrom({ r: 0, g: 0, b: 0 })).toBe("dark");
	});
});

describe("resolveGround — the ladder", () => {
	it("1. an explicit answer wins over everything below it", () => {
		expect(resolveGround({ theme: "dark", osc: "11;rgb:ffff/ffff/ffff", colorfgbg: "0;15" })).toBe("dark");
		expect(resolveGround({ theme: "  LIGHT  " })).toBe("light");
	});

	it("2. the OSC answer wins over COLORFGBG", () => {
		expect(resolveGround({ osc: "11;rgb:ffff/ffff/ffff", colorfgbg: "15;0" })).toBe("light");
	});

	it("3. COLORFGBG when there is no answer", () => {
		expect(resolveGround({ colorfgbg: "0;15" })).toBe("light");
		expect(resolveGround({ colorfgbg: "15;0" })).toBe("dark");
		expect(resolveGround({ colorfgbg: "15;default;0" })).toBe("dark");
	});

	it("4. unknown when nothing answers — including for junk at every rung", () => {
		expect(resolveGround({})).toBe("unknown");
		expect(resolveGround({ theme: "chartreuse" })).toBe("unknown");
		expect(resolveGround({ osc: "52;c;AAAA" })).toBe("unknown");
		expect(resolveGround({ colorfgbg: "" })).toBe("unknown");
		expect(resolveGround({ colorfgbg: "nonsense" })).toBe("unknown");
	});

	it("the measured Apple Terminal case resolves light", () => {
		// the probe's own output, verbatim
		expect(resolveGround({ osc: "11;rgb:ffff/ffff/ffff", colorfgbg: undefined })).toBe("light");
	});
});
