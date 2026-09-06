/**
 * S3 D-2 — `widthCut` steps by CODE POINT.
 *
 * The declared re-derivation: an astral code point (an emoji) counts
 * its true width and is never split between its surrogates. The cutter
 * it replaced stepped by UTF-16 unit, so a cut that landed inside an
 * emoji returned a lone high surrogate — a prefix that is not valid
 * text and measures differently on the next pass. Red on the old
 * algorithm: the first and second cases below.
 */
import { describe, expect, it } from "vitest";
import { displayWidth, widthCut } from "../src/width.js";

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("S3 D-2 — widthCut never splits an astral code point", () => {
	it("a cut that would land inside an emoji stops before it", () => {
		expect(widthCut("ab😀cd", 3)).toBe("ab");
		expect(widthCut("ab😀cd", 4)).toBe("ab😀");
		expect(widthCut("😀", 1)).toBe("");
	});

	it("at every budget the prefix is a prefix, holds no lone surrogate, and fits", () => {
		const text = "x😀y🚀z✦w";
		for (let max = 0; max <= displayWidth(text); max += 1) {
			const cut = widthCut(text, max);
			expect(cut).not.toMatch(loneSurrogate);
			expect(displayWidth(cut)).toBeLessThanOrEqual(max);
			expect(text.startsWith(cut)).toBe(true);
		}
	});

	it("BMP text is untouched by the change — the cell cut every pinned row relies on", () => {
		expect(widthCut("abcdef", 3)).toBe("abc");
		expect(widthCut("中文字", 3)).toBe("中");
		expect(widthCut("中文字", 4)).toBe("中文");
		expect(widthCut("abc", 0)).toBe("");
	});
});
