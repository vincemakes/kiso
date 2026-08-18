/**
 * The display-width primitives — the SINGLE width authority (TUI v5
 * #16e: "charWidth is the width authority"). The table covers the East
 * Asian Wide/Fullwidth ranges and Emoji_Presentation=Yes; everything
 * else is one column, the box-drawing/brick glyphs █▀▄▞▸ and the text-
 * presentation marks ✓ ✗ ⚠ ⏸ included.
 *
 * This is the compositor's FLOOR, not a cosmetic detail: a glyph scored
 * one column that a terminal draws in two makes a line whose measured
 * width is <= W really need W+1, the terminal soft-wraps the tail onto
 * the row below, and the live region silently eats a row it never
 * budgeted (TUI2-R2pre ① — the composer clobber).
 *
 * Known limitation, documented in the README: emoji ZWJ clusters and
 * variation-selector sequences are not guaranteed perfect — each code
 * point counts as its own width (U+26A0 + FE0F sums to 2, which is what
 * a terminal draws, but that is arithmetic luck, not a model).
 * Zero dependencies (importable from any module).
 */

/** TUI2-R2pre ① — the Emoji_Presentation=Yes code points inside
 *  U+2000..U+2BFF. The rest of that span is TEXT presentation and stays
 *  one column: ✓ ✗ ⚠ ⏸ ▞ ▸ and the box-drawing rails are all narrow, and
 *  widening any of them would move every card head on the screen. Listed
 *  as ranges because that is what the property is — the singles are
 *  singles in Unicode too. */
const EMOJI_PRESENTATION: readonly (readonly [number, number])[] = [
	[0x231a, 0x231b],
	[0x23e9, 0x23ec],
	[0x23f0, 0x23f0],
	[0x23f3, 0x23f3],
	[0x25fd, 0x25fe],
	[0x2614, 0x2615],
	[0x2648, 0x2653],
	[0x267f, 0x267f],
	[0x2693, 0x2693],
	[0x26a1, 0x26a1],
	[0x26aa, 0x26ab],
	[0x26bd, 0x26be],
	[0x26c4, 0x26c5],
	[0x26ce, 0x26ce],
	[0x26d4, 0x26d4],
	[0x26ea, 0x26ea],
	[0x26f2, 0x26f3],
	[0x26f5, 0x26f5],
	[0x26fa, 0x26fa],
	[0x26fd, 0x26fd],
	[0x2705, 0x2705],
	[0x270a, 0x270b],
	[0x2728, 0x2728],
	[0x274c, 0x274c],
	[0x274e, 0x274e],
	[0x2753, 0x2755],
	[0x2757, 0x2757],
	[0x2795, 0x2797],
	[0x27b0, 0x27b0],
	[0x27bf, 0x27bf],
	[0x2b1b, 0x2b1c],
	[0x2b50, 0x2b50],
	[0x2b55, 0x2b55],
];

/** A code point's display width: 2 for the wide ranges, 1 otherwise. */
export function charWidth(cp: number): number {
	if (cp >= 0x1100 && cp <= 0x115f) return 2; // hangul jamo
	if (cp >= 0x2e80 && cp <= 0x303e) return 2; // radicals .. CJK punctuation
	if (cp >= 0x3041 && cp <= 0x33ff) return 2; // kana, CJK compat
	if (cp >= 0x3400 && cp <= 0x4dbf) return 2; // CJK ext A
	if (cp >= 0x4e00 && cp <= 0x9fff) return 2; // CJK unified
	if (cp >= 0xa000 && cp <= 0xa4cf) return 2; // yi
	if (cp >= 0xa960 && cp <= 0xa97f) return 2; // hangul jamo ext
	if (cp >= 0xac00 && cp <= 0xd7a3) return 2; // hangul syllables
	if (cp >= 0xf900 && cp <= 0xfaff) return 2; // CJK compat ideographs
	if (cp >= 0xfe10 && cp <= 0xfe19) return 2; // vertical forms
	if (cp >= 0xfe30 && cp <= 0xfe6f) return 2; // CJK compat forms
	if (cp >= 0xff00 && cp <= 0xff60) return 2; // fullwidth forms
	if (cp >= 0xffe0 && cp <= 0xffe6) return 2; // fullwidth signs
	// TUI2-R1.5 shipped only two of the pictographic ranges; the holes
	// (transport, mahjong/cards, enclosed, colored shapes, the extended
	// block) were scored ONE column while every terminal draws them in
	// two — the composer clobber of the owner's field report (①).
	if (cp === 0x1f004 || cp === 0x1f0cf) return 2; // mahjong red dragon, joker
	if (cp >= 0x1f18e && cp <= 0x1f19a) return 2; // enclosed alphanumerics
	if (cp >= 0x1f200 && cp <= 0x1f251) return 2; // enclosed ideographic
	if (cp >= 0x1f300 && cp <= 0x1f64f) return 2; // emoji (misc + emoticons)
	if (cp >= 0x1f680 && cp <= 0x1f6ff) return 2; // transport + map
	if (cp >= 0x1f7e0 && cp <= 0x1f7eb) return 2; // colored circles + squares
	if (cp >= 0x1f900 && cp <= 0x1f9ff) return 2; // supplemental emoji
	if (cp >= 0x1fa70 && cp <= 0x1faff) return 2; // symbols + pictographs ext-A
	if (cp >= 0x20000 && cp <= 0x3fffd) return 2; // CJK ext B..G
	if (cp >= 0x231a && cp <= 0x2b55) {
		for (const [lo, hi] of EMOJI_PRESENTATION) if (cp >= lo && cp <= hi) return 2;
	}
	return 1;
}

/** Display width of a code-point array (cursor math, scrolling). */
export function widthOf(chars: readonly number[]): number {
	let w = 0;
	for (const cp of chars) w += charWidth(cp);
	return w;
}

/** Display width of a string. */
export function displayWidth(text: string): number {
	let w = 0;
	for (const ch of text) w += charWidth(ch.codePointAt(0)!);
	return w;
}

/** A LEAD's display width — the prompt / the panel's phase lead,
 *  ANSI-stripped. W23: the ONE width authority shared by the editor
 *  (selfRender, #reflow), the compositor's #inputRow, and editCol — a
 *  lead can never measure differently at two call sites (the frame-
 *  derived column contract: wallL + leadWidth(lead) + cells + 1). */
export function leadWidth(lead: string): number {
	return displayWidth(lead.replace(/\x1b\[[0-9;]*m/g, ""));
}
