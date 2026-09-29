/**
 * The palette and its ground (design.md §2, §3).
 *
 * DC-3's rule stands and is what this file is built on: an absolute
 * colour is a claim about the background, so a palette that does not
 * know its ground carries none — the UNKNOWN ground keeps attributes and
 * the terminal's own colours (SGR 2, 7, 31, 32, 33).
 *
 * Graphite (owner-ruled 2026-09-28) replaces the index table that DC-3,
 * DC-9, R3 and R9 P3 pinned here. What is gated now is the contract, not
 * a value: every text token clears the 4.5:1 floor on every surface it
 * can reach, AS SHOWN — in the 24-bit tier and after the 256 tier rounds
 * to its nearest index — on the reference grounds and on a sweep of real
 * terminal grounds the surfaces are derived from (§3.4). A pinned index
 * only proves a value did not move; these fail when a colour stops
 * working.
 */

import { afterEach, describe, expect, it } from "vitest";
import { COLOR_DARK, COLOR_LIGHT, COLOR_NEUTRAL, COLOR_OFF, currentGroundRgb, palette, paletteFor, setGround, type Palette } from "../src/render.js";
import {
	CARDS,
	GRAPHITE,
	bg,
	mix,
	SURFACES,
	colourTier,
	contrast,
	deriveSurface,
	fg,
	graphiteColours,
	hexRgb,
	nearest256,
	rgbHex,
	shown,
	weakestPair,
	xterm256,
	type Kind,
	type Tier,
} from "../src/graphite.js";

const tty = (on: boolean): void => {
	Object.defineProperty(process.stdout, "isTTY", { value: on, configurable: true });
};
afterEach(() => {
	setGround("unknown");
	process.env.COLORTERM = "truecolor";
});

/** Real terminal grounds, by kind: the reference pair, pure black, the
 *  common dark themes (one dark, nord, solarized, dracula, the Ubuntu
 *  aubergine, tomorrow night) and the common light ones. */
const GROUNDS: Record<Kind, readonly string[]> = {
	light: ["#ffffff", "#fafafa", "#f5f5f5", "#eeeeee", "#fdf6e3"],
	dark: ["#0b0b0b", "#000000", "#1e1e1e", "#1d1f21", "#282c34", "#2e3440", "#002b36", "#282a36", "#300a24"],
};
const TIERS: readonly Tier[] = ["24bit", "256"];

/** Every SGR colour in a palette's string members. */
const colours = (p: Palette): string[] =>
	Object.values(p)
		.filter((v): v is string => typeof v === "string")
		.flatMap((v) => [...v.matchAll(/\x1b\[(?:38|48);(?:2;\d+;\d+;\d+|5;\d+)m/g)].map((m) => m[0]));

describe("§2.1 — every text token clears the floor on every surface it reaches, as shown", () => {
	for (const tier of TIERS)
		for (const kind of ["light", "dark"] as const) {
			it(`${tier} · ${kind}: the table on its reference ground`, () => {
				const w = weakestPair(graphiteColours(kind, null, tier), tier);
				expect(w.ratio, `${w.pair.join(" on ")}`).toBeGreaterThanOrEqual(4.5);
			});
			for (const g of GROUNDS[kind])
				it(`${tier} · ${kind}: derived for a reported ${g}`, () => {
					const w = weakestPair(graphiteColours(kind, hexRgb(g), tier), tier);
					expect(w.ratio, `${w.pair.join(" on ")}`).toBeGreaterThanOrEqual(4.5);
				});
		}
});

describe("§3.4 — the surfaces are derived from the reported ground", () => {
	it("the two reference grounds reproduce the table exactly, for every surface", () => {
		for (const s of SURFACES) {
			expect(rgbHex(deriveSurface(s, hexRgb(GRAPHITE.light.ground))), `${s} on white`).toBe(GRAPHITE.light[s]);
			expect(rgbHex(deriveSurface(s, hexRgb(GRAPHITE.dark.ground))), `${s} on black`).toBe(GRAPHITE.dark[s]);
		}
	});

	it("…and nothing else moves there: the reference grounds give the table, token for token", () => {
		for (const kind of ["light", "dark"] as const)
			for (const tier of TIERS) {
				const c = graphiteColours(kind, hexRgb(GRAPHITE[kind].ground), tier);
				for (const [k, v] of Object.entries(GRAPHITE[kind])) expect(rgbHex(c[k as keyof typeof c]), `${kind} ${tier} ${k}`).toBe(v);
			}
	});

	it("a card stands off ANY ground it was derived for — the complaint the derivation answers", () => {
		for (const kind of ["light", "dark"] as const)
			for (const g of GROUNDS[kind]) {
				const c = graphiteColours(kind, hexRgb(g));
				for (const card of CARDS) expect(contrast(c[card], hexRgb(g)), `${card} on ${g}`).toBeGreaterThanOrEqual(1.1);
			}
	});

	it("a ground of the OTHER kind derives nothing — the human's explicit answer wins", () => {
		expect(graphiteColours("light", hexRgb("#1e1e1e"))).toEqual(graphiteColours("light", null));
		expect(graphiteColours("dark", hexRgb("#fdf6e3"))).toEqual(graphiteColours("dark", null));
	});

	it("a lighter dark theme LIFTS dim rather than dropping under the floor on the bare ground", () => {
		const nord = hexRgb("#2e3440");
		expect(contrast(hexRgb(GRAPHITE.dark.dim), nord), "the table's dim fails on nord").toBeLessThan(4.5);
		expect(contrast(graphiteColours("dark", nord).dim, nord)).toBeGreaterThanOrEqual(4.5);
	});
});

describe("§2 — the tier", () => {
	it("24-bit only where COLORTERM says the terminal renders it", () => {
		for (const v of ["truecolor", "24bit", "TrueColor", " truecolor "]) expect(colourTier(v), v).toBe("24bit");
		for (const v of [undefined, "", "256", "yes", "true"]) expect(colourTier(v), String(v)).toBe("256");
	});

	it("the 256 tier writes the nearest index, which round-trips every index 16–255", () => {
		for (let i = 16; i <= 255; i += 1) expect(nearest256(xterm256(i))).toBe(i);
		expect(fg(hexRgb("#646464"), "256")).toBe(`\x1b[38;5;${nearest256(hexRgb("#646464"))}m`);
		expect(fg(hexRgb("#646464"), "24bit")).toBe("\x1b[38;2;100;100;100m");
	});

	it("the floor is measured on the rounded colour, not the intended one", () => {
		const c = graphiteColours("dark", hexRgb("#1e1e1e"), "256");
		expect(contrast(shown(c.dim, "256"), shown(c.washRun, "256"))).toBeGreaterThanOrEqual(4.5);
	});
});

describe("the palette writes the Graphite colours, and only them", () => {
	it("a known-ground palette's every colour is a Graphite colour of that set", () => {
		for (const kind of ["light", "dark"] as const)
			for (const tier of TIERS) {
				const c = graphiteColours(kind, null, tier);
				const allowed = new Set(Object.values(c).flatMap((x) => [fg(x, tier), fg(x, tier).replace("[38;", "[48;")]));
				const p = paletteFor(kind, null, tier);
				const breath = new Set(p.breath);
				// Graphite §7.4 (R1f): a card's EDGE is its ground deepened toward
				// the state's colour — a derived colour, stated here by its recipe
				const edges = new Set([p.runEdge, p.failEdge, p.askEdge]);
				expect(p.runEdge).toBe(bg(mix(c.washRun, c.blue, 0.22), tier));
				expect(p.failEdge).toBe(bg(mix(c.washFail, c.fail, 0.22), tier));
				expect(p.askEdge).toBe(bg(mix(c.washAsk, c.goldMark, 0.22), tier));
				for (const code of colours(p)) expect(allowed.has(code) || breath.has(code) || edges.has(code), `${kind} ${tier} ${JSON.stringify(code)}`).toBe(true);
			}
	});

	it("the names the older code reads carry the Graphite value of the same job", () => {
		for (const [p, kind] of [
			[COLOR_LIGHT, "light"],
			[COLOR_DARK, "dark"],
		] as const) {
			const c = graphiteColours(kind, null);
			expect(p.dim).toBe(fg(c.dim, "24bit"));
			expect(p.red).toBe(fg(c.fail, "24bit"));
			expect(p.green).toBe(fg(c.ok, "24bit"));
			expect(p.warn, "the uncertain badge is a question for the person: gold").toBe(fg(c.gold, "24bit"));
			expect(p.washDim, "dim clears the floor on every card, so the separate grey retires in value").toBe(p.dim);
		}
		expect(COLOR_LIGHT.red).not.toBe(COLOR_DARK.red);
	});
});

describe("DC-3 — the unknown ground carries no absolute colour at all", () => {
	it("attributes and the terminal's own colours only", () => {
		expect(colours(COLOR_NEUTRAL)).toEqual([]);
		expect(COLOR_NEUTRAL.dim).toBe("\x1b[2m");
		expect(COLOR_NEUTRAL.red).toBe("\x1b[31m");
		expect(COLOR_NEUTRAL.wash).toBe("\x1b[7m");
		expect(COLOR_NEUTRAL.washEnd).toBe("\x1b[27m");
		expect(COLOR_NEUTRAL.washDim).toBe("");
		expect(COLOR_NEUTRAL.breath).toEqual([]);
		expect(COLOR_NEUTRAL.tier).toBeNull();
	});

	it("colour off spends nothing", () => {
		expect(colours(COLOR_OFF)).toEqual([]);
		for (const [k, v] of Object.entries(COLOR_OFF)) if (typeof v === "string") expect(v, k).toBe("");
	});

	it("code is the wash — a surface, never a foreground tint", () => {
		for (const p of [COLOR_NEUTRAL, COLOR_LIGHT, COLOR_DARK, COLOR_OFF]) expect(p.code).toBe(p.wash);
	});

	it("a known ground closes its surfaces with 49 and its greys with 39, never SGR 0", () => {
		for (const p of [COLOR_LIGHT, COLOR_DARK]) {
			expect(p.washEnd).toBe("\x1b[49m");
			expect(p.washDimEnd).toBe("\x1b[39m");
			expect(p.fgEnd).toBe("\x1b[39m");
		}
	});
});

describe("setGround and the tier select the palette", () => {
	it("routes to the ground's own palette in the suite's 24-bit tier, and back to neutral", () => {
		tty(true);
		setGround("light");
		expect(palette()).toEqual(COLOR_LIGHT);
		setGround("dark");
		expect(palette()).toEqual(COLOR_DARK);
		setGround("unknown");
		expect(palette()).toBe(COLOR_NEUTRAL);
	});

	it("without COLORTERM the same ground is written in the 256 tier", () => {
		tty(true);
		delete process.env.COLORTERM;
		setGround("dark");
		expect(palette()).toEqual(paletteFor("dark", null, "256"));
		expect(palette().dim).toMatch(/^\x1b\[38;5;\d+m$/);
	});

	it("a reported colour reaches the palette: the card of a #1e1e1e terminal is its own", () => {
		tty(true);
		const g = hexRgb("#1e1e1e");
		setGround("dark", g);
		expect(currentGroundRgb()).toEqual(g);
		expect(palette().wash).toBe(paletteFor("dark", g, "24bit").wash);
		expect(palette().wash).not.toBe(COLOR_DARK.wash);
	});

	it("an unknown ground drops the reported colour with it", () => {
		setGround("dark", hexRgb("#1e1e1e"));
		setGround("unknown", hexRgb("#1e1e1e"));
		expect(currentGroundRgb()).toBeNull();
	});
});
