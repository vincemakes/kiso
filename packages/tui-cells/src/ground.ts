/**
 * DC-3 §1 — the GROUND: is the terminal light or dark.
 *
 * Every colour in the palette is chosen against a background, and until
 * now kiso had no way to know what that background was: `palette()`
 * returned one constant, its greys were picked on a dark terminal, and
 * on a white one the inline-code token measured 1.54:1 against a 4.5:1
 * floor (finding DC-3).
 *
 * This module is the answer, and it is deliberately PURE. The terminal's
 * reply arrives as a string and the environment arrives as fields, so
 * the whole decision is testable without a terminal and the terminal
 * work is reduced to plumbing.
 *
 * `unknown` is a real answer, not a failure. It means the caller must
 * use the mark that is correct on ANY ground — reverse video rather than
 * a wash, the terminal's own dim rather than a chosen grey. A design
 * that degrades is the price of never painting light-mode paint onto a
 * dark screen.
 */

export type Ground = "light" | "dark" | "unknown";

export interface Rgb {
	readonly r: number;
	readonly g: number;
	readonly b: number;
}

/** `<n>;rgb:R/G/B` with 1–4 hex digits per component — the body of an
 *  OSC 10/11 answer, already stripped of its introducer and terminator
 *  by the editor (DC-7). Anything else is null: a guess about the
 *  ground is worse than admitting there isn't one. */
const OSC_RGB = /^\d+;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i;

export function parseOscColor(body: string): Rgb | null {
	const m = OSC_RGB.exec(body.trim());
	if (m === null) return null;
	// a component is n hex digits of a full-scale value, so it scales by
	// its own maximum — `f` is full white exactly as `ffff` is.
	const comp = (h: string): number => Math.round((Number.parseInt(h, 16) / (16 ** h.length - 1)) * 255);
	return { r: comp(m[1]!), g: comp(m[2]!), b: comp(m[3]!) };
}

/** The WCAG relative luminance — the same formula the contrast ratios in
 *  `packages/tui/design.md` §2 are computed with, so the ground and the
 *  floor cannot drift apart. */
export function relativeLuminance({ r, g, b }: Rgb): number {
	const lin = (v: number): number => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function groundFrom(rgb: Rgb): Exclude<Ground, "unknown"> {
	return relativeLuminance(rgb) > 0.5 ? "light" : "dark";
}

/** COLORFGBG is `fg;bg` or `fg;default;bg` — the BACKGROUND is the last
 *  field, as an ANSI index. 0–6 and 8 are the dark half of the sixteen;
 *  7 and 9–15 are the light half. Absent on most terminals, which is why
 *  it sits below the question kiso can actually ask. */
function fromColorFgBg(value: string): Ground {
	const fields = value.split(";");
	const bg = Number.parseInt(fields[fields.length - 1] ?? "", 10);
	if (!Number.isInteger(bg) || bg < 0 || bg > 15) return "unknown";
	return bg === 7 || bg >= 9 ? "light" : "dark";
}

export interface GroundInputs {
	/** KISO_THEME, or the user config's `theme` — an explicit answer from
	 *  the human. The environment wins over the file; both are rung 1. */
	readonly theme?: string | undefined;
	/** The terminal's OWN account of its colour scheme, from its answer to
	 *  `CSI ? 996 n` (`CSI ? 997 ; 1|2 n`). */
	readonly colorScheme?: "dark" | "light" | undefined;
	/** The body of the terminal's OSC 11 answer, if one arrived. */
	readonly osc?: string | undefined;
	/** The COLORFGBG environment variable, if it is set. */
	readonly colorfgbg?: string | undefined;
}

/**
 * The ladder, first hit wins. Every rung that cannot answer falls
 * through rather than guessing, and the bottom of the ladder is
 * `unknown` — see the module comment for why that is a result.
 *
 *   1  theme        an explicit answer from the human (env, then config)
 *   2  colorScheme  the terminal's own report (CSI 997)
 *   3  osc          the background colour, and a luminance threshold
 *   4  colorfgbg    an environment variable some terminals set
 *      unknown      reverse video, correct on any ground
 *
 * kiso never guesses. A terminal that answers nothing and a human who
 * set nothing leave the ground `unknown`, and `unknown` degrades — it
 * does not default to dark and hope.
 */
export function resolveGround({ theme, colorScheme, osc, colorfgbg }: GroundInputs): Ground {
	const explicit = theme?.trim().toLowerCase();
	if (explicit === "light" || explicit === "dark") return explicit;
	// The terminal's own REPORT outranks the colour it hands over. OSC 11
	// gives a background colour and kiso infers a ground from its
	// luminance — a threshold applied to someone else's number. `CSI 997`
	// is the terminal saying which it is. When both answer they normally
	// agree; when they do not, the account beats the inference.
	if (colorScheme === "dark" || colorScheme === "light") return colorScheme;
	if (osc !== undefined && osc !== "") {
		const rgb = parseOscColor(osc);
		if (rgb !== null) return groundFrom(rgb);
	}
	if (colorfgbg !== undefined && colorfgbg !== "") return fromColorFgBg(colorfgbg);
	return "unknown";
}
