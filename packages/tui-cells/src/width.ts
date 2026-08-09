/**
 * The display-width primitives — the SINGLE width authority (TUI v5
 * #16e: "charWidth is the width authority"). The eastAsianWidth table
 * is a ~40-line subset (CJK ideographs/kana/hangul/fullwidth/common
 * wide symbols = 2, everything else = 1 — the box-drawing/brick glyphs
 * █▀▄▞▸ are narrow). Known limitation, documented in the README: emoji
 * ZWJ clusters are not guaranteed perfect — each code point counts as
 * its width. Zero dependencies (importable from any module).
 */

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
	if (cp >= 0x1f300 && cp <= 0x1f64f) return 2; // emoji (misc + emoticons)
	if (cp >= 0x1f900 && cp <= 0x1f9ff) return 2; // supplemental emoji
	if (cp >= 0x20000 && cp <= 0x3fffd) return 2; // CJK ext B..G
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
