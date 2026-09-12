import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name: string): string => readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), "utf8");

/**
 * The Chinese edition's needles, as ESCAPES on purpose. The tracked tree is
 * English-only (scripts/check-cjk.mjs) with README.zh.md the single
 * exemption, so a test that asserts on that edition cannot hold its words
 * literally. Written out, in order: "committed durable prefix",
 * "regenerated", "handed to a human to rule on", "upper bound", "path".
 */
const ZH = {
	committedPrefix: "\u5df2\u63d0\u4ea4\u7684\u6301\u4e45\u524d\u7f00",
	regenerated: "\u91cd\u65b0\u751f\u6210",
	humanRuling: "\u4ea4\u7ed9\u4eba",
	cappedAt: "\u4e0a\u9650",
	path: "\u8def\u5f84",
} as const;
const EDITIONS = [["README.md", read("README.md")], ["README.zh.md", read("README.zh.md")]] as const;

/**
 * Astra F8 and F9 — TWO README CLAIMS THAT WERE BIGGER THAN THE PRODUCT.
 *
 * F8: `ctrl+v` image attach is advertised beside "macOS or Linux" support,
 * and `clipboardImage` returns null on any platform but darwin. The gesture
 * cannot work there.
 *
 * F9: the opening promised resumption "exactly where it stopped". The
 * runtime abandons a model-output suffix that has no committed stop and
 * drives the model again from the committed projection. Durable committed
 * receipts survive; unfinished generation and ambiguous effects do not, and
 * the repeated request is paid for.
 *
 * These gates are about the CLAIM'S SURFACE, which is the lesson the
 * findings carry: the credential sentence was overstated for two months
 * because its gate covered the case that motivated it and not the claim.
 */
describe("F8: the clipboard gesture is advertised with its platform", () => {
	it("every edition qualifies ctrl+v as macOS", () => {
		for (const [name, text] of EDITIONS) {
			const at = text.indexOf("ctrl+v");
			expect(at, `${name}: no ctrl+v mention at all`).toBeGreaterThanOrEqual(0);
			// the qualification rides WITH the gesture, not in a distant footnote
			expect(text.slice(at, at + 400), name).toMatch(/macOS/);
		}
	});

	it("the path route is offered as the thing that works elsewhere", () => {
		for (const [name, text] of EDITIONS) expect(text, name).toMatch(new RegExp(`path|${ZH.path}`));
	});
});

describe("F9: the durability claim is the committed prefix, not exact continuation", () => {
	it("the old absolute promises are gone from the English opening", () => {
		const en = read("README.md");
		expect(en).not.toContain("resumes exactly where it");
		expect(en).not.toContain("costs nothing but\nthe process");
	});

	it("every edition states the committed prefix AND what is not covered", () => {
		for (const [name, text] of EDITIONS) {
			expect(text, `${name}: no committed-prefix wording`).toMatch(new RegExp(`committed prefix|${ZH.committedPrefix}`));
			expect(text, `${name}: silent about regeneration`).toMatch(new RegExp(`regenerated|${ZH.regenerated}`));
			expect(text, `${name}: silent about the human ruling`).toMatch(new RegExp(`human|${ZH.humanRuling}`));
		}
	});

	it("the kernel line says CAPPED rather than implying the core is exactly the cap", () => {
		expect(read("README.md")).toMatch(/capped at 2,200/);
		expect(read("README.zh.md")).toContain(ZH.cappedAt);
	});
});
