/**
 * tui-cells — the render slice (ADR-0043 Amendment 4): the
 * cell-rendering helpers components.ts imports — moved verbatim from
 * the tui's render.ts, never duplicated. Pure (testable): given text,
 * produce the bytes a human sees. Colors are raw ANSI — zero
 * dependencies (the tui-cells package has none).
 */

import { charWidth, displayWidth } from "./width.js";
import type { Ground } from "./ground.js";

/**
 * v2a — the palette, centralized (no hard-coded codes elsewhere); v5
 * (TUI v5 #16e, the v4.1 design): the decorative blue (38;5;75) is
 * RETIRED — the identity accents (the you> prompt, the banner tagline,
 * ✓ marks, slash-command names, the input brick) are bright-white BOLD
 * (SGR 1); the user message is the SGR-7 chip (the 2026-08-09 ruling
 * retired the ▍ rail); red for errors, dim for metadata, green for the
 * diff additions. NO_COLOR set, or a non-TTY output → every code is
 * empty, so pipes and CI carry ZERO ANSI (the existing byte-level e2e
 * assertions guard it). Everything not listed is plain.
 *
 * KC3 §2 — THE MONO DISCIPLINE (the owner's 2026-08-17 ruling, a
 * DECLARED SUPERSESSION under ADR-0051 Amendment 3). The interface's
 * body is carried by shades of black and white; green ✓, yellow warn
 * and red error are the ONLY functional exceptions. v5 had already
 * taken the identity accents to bold; `code` was the one chromatic
 * entry left — the light BLUE 38;5;110 — and it becomes the light GRAY
 * 38;5;252. A tint still says "this span is code", which is the job it
 * was hired for; saying it in a hue was never the job.
 *
 * The functional colors are deliberately NOT moved and not
 * approximated: red stays SGR 31, green stays SGR 32. A reader who has
 * learned that colour means something must keep being right.
 *
 * R2's retired wordmark, re-measured 2026-09-02 and recorded so the
 * question is not reopened from memory: braille (U+2800–U+28FF) IS
 * available — Apple Terminal's default Menlo falls back to Apple
 * Braille and draws solid dots, correcting what design.md §6 used to
 * say. Rasterised through it, a four-leaf mark reads from 12×6 cells
 * upward and turns to dominoes below 10×5 — the same threshold R2
 * measured for block characters — and a dense tiling bands
 * horizontally, because the font's dot pitch does not divide the cell
 * height. The owner looked at it on the real terminal and declined it.
 * §7.10 stands: no logo, the name is the mark.
 */
export interface Palette {
	readonly bold: string;
	readonly dim: string;
	readonly red: string;
	readonly green: string; // v2e: the diff additions — diff-only (NO_COLOR falls back to the + prefix)
	/** TUI2-R2 ①: the third functional exception, finally spelled. The
	 *  mono-discipline ruling above names "green ✓, yellow warn and red
	 *  error" as the ONLY functional colours; warn had no entry because
	 *  nothing had needed it yet. The uncertain badge needs exactly it —
	 *  a state that is neither success nor failure but a question
	 *  addressed to the human. This is the ruling's own set gaining its
	 *  missing member, not a fourth colour. */
	readonly warn: string;
	/** DC-3 — RETIRED as a tint; kept as an alias of `wash` so nothing
	 *  reading it gets the old absolute grey. It was 256-colour index 252
	 *  (#d0d0d0): 1.54:1 on a white terminal, against a 4.5:1 floor, and
	 *  five call sites shared it. Inline code is a SURFACE now — never a
	 *  foreground tint, and never applied to a whole fenced block, whose
	 *  `│` gutter already says the same thing more cheaply. */
	readonly code: string;
	/** TUI2-MD (MD-1, the owner's circle) — the markdown round's ONE new
	 *  member. `*italic*` needs a rendering, and under the mono discipline
	 *  the answer cannot be a colour: SGR 3 is an ATTRIBUTE, it costs the
	 *  alphabet nothing chromatic, and a terminal without italics simply
	 *  draws the text — a harmless degradation rather than a lie.
	 *  It ships with its own close (23) for the same reason `rv` does: an
	 *  italic span inside a bold heading must be able to end WITHOUT the
	 *  SGR-0 that would strand the heading's own style. */
	readonly italic: string;
	readonly italicEnd: string;
	/** DC-4 — the heading round's ONE new member, on the italic precedent:
	 *  SGR 4 is an ATTRIBUTE, so it costs the alphabet nothing chromatic
	 *  and a terminal without underlines simply draws the text. It carries
	 *  the level-1 heading; levels 3 and below carry their own `###`,
	 *  because attributes run out and a marker survives a pipe. */
	readonly underline: string;
	readonly underlineEnd: string;
	readonly rv: string; // W16: reverse video — SGR 7, closed with rvEnd (27, never SGR 0 — the chip composes with a surrounding span)
	readonly rvEnd: string;
	/** DC-3 — the VERBATIM surface: the human's own words, and inline
	 *  code. A background, so it needs the ground; with no ground it is
	 *  reverse video, which is correct on any ground and is the LAST rung of the
	 *  ladder in `ground.ts`. Closed with 49 rather than SGR 0, for the
	 *  reason `rv` is closed with 27: a washed span sits inside other
	 *  spans and must end without stranding them. */
	readonly wash: string;
	readonly washEnd: string;
	/** R7a — THE FOCUS MARKER'S EMPHASIS, and it is not a background.
	 *
	 *  DC-3 gave the `ctrl+o` token the wash, which is a BACKGROUND once
	 *  a ground is resolved: `48;5;236` on dark reads as a black block
	 *  behind the key, on a row that is otherwise plain text. The owner
	 *  asked for it gone. The invariant DC-3 was serving — exactly one
	 *  bright token per frame, because the key has exactly one target —
	 *  never required a background; it required CONTRAST against the dim
	 *  siblings, and full-strength bold foreground is more of it than a
	 *  wash was.
	 *
	 *  Three escapes because "dim" has two forms here: SGR 2 in the
	 *  neutral palette, a 256-colour foreground in the resolved ones.
	 *  22 cancels the attribute, 39 restores the default foreground, 1
	 *  is the emphasis. It closes by re-opening the palette's own dim,
	 *  like `washEnd`, so the surrounding span survives. */
	readonly lift: string;
	/** R9 P3 — THE ONE GREY ALLOWED ON THE WASH.
	 *
	 *  §2.1 bars `dim` from the wash and the measurement is why: `#767676`
	 *  on `#EEEEEE` is 3.91:1, under the 4.5:1 floor. A washed surface
	 *  carrying metadata rows — a slab's `… N earlier lines`, its outcome
	 *  line — still wants them quieter than the output they annotate, so
	 *  the palette gains a grey chosen FOR the wash rather than against
	 *  the ground:
	 *
	 *    light  241 `#626262`  5.26:1 on the wash, 6.10:1 on the ground
	 *    dark   247 `#9E9E9E`  4.93:1 on the wash, 6.22:1 on the ground
	 *
	 *  §2.1 is untouched — `dim` still may not sit on the wash. This is a
	 *  different token with a different job, the way `warn` was the mono
	 *  ruling's own set gaining its missing member.
	 *
	 *  With NO ground it is NOTHING: §3.1 forbids an absolute foreground
	 *  in a palette that has not established a background, and the last rung's
	 *  wash is reverse video, where any foreground grey inverts into a
	 *  grey block. Body text on the surface is the correct degradation.
	 *  It closes with 39 (the default foreground) rather than SGR 0, for
	 *  the reason `washEnd` closes with 49: the wash underneath it must
	 *  survive the close. */
	readonly washDim: string;
	readonly washDimEnd: string;
	readonly reset: string;
}
const BASE = { bold: "\x1b[1m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", warn: "\x1b[33m", italic: "\x1b[3m", italicEnd: "\x1b[23m", underline: "\x1b[4m", underlineEnd: "\x1b[24m", rv: "\x1b[7m", rvEnd: "\x1b[27m", reset: "\x1b[0m" } as const;
/**
 * DC-9 (design §2.3) — the failure colour is theme-resolved.
 *
 * ANSI 31 is 5.89:1 on a white ground and 2.83:1 on a dark one: the one
 * token in the alphabet whose whole job is "this went wrong" was the
 * least readable thing on the screen exactly where a dark-terminal user
 * reads it. A failure is CONTENT (law 1.2 admits colour there), so it
 * cannot degrade to an attribute the way `dim` does — it needs a value
 * per ground, and the ground is what §3's ladder is for.
 *
 * 256-cube indices, never truecolor (§2). Measured against the grounds
 * §2 measures against — white, and #1E1E1E:
 *
 *   light  124 `#af0000`  7.44:1
 *   dark   173 `#d7875f`  5.97:1
 *
 * With NO ground established the token stays ANSI 31 — the TERMINAL's
 * own red, which its theme picked for its own background. That is the last rung
 * 4's principle exactly: when the ground is unknown, use the thing that
 * is correct on any ground rather than guessing one.
 */
/** `washDimEnd` is DERIVED, never passed: a grey that cannot be closed
 *  without taking the wash with it is not a usable token, and deriving
 *  the close makes the pair impossible to mis-wire at a call site. */
const withWash = (wash: string, washEnd: string, red: string = BASE.red, dim: string = BASE.dim, washDim = ""): Palette => ({
	...BASE,
	red,
	dim,
	wash,
	washEnd,
	washDim,
	washDimEnd: washDim === "" ? "" : "\x1b[39m",
	code: wash,
	lift: "\x1b[22m\x1b[39m\x1b[1m",
});
/**
 * DC-3 — one table per ground.
 *
 * R3 (owner, 2026-08-27) — `dim` is ABSOLUTE once the ground is known,
 * and design.md §2's table always said so: light `243` `#767676` at
 * 4.54:1, dark `246` `#949494` at 5.50:1 (both re-measured here).
 *
 * DC-3 shipped SGR 2 instead, on the argument that an attribute adapts
 * to the ground while an absolute grey asserts one. That argument is
 * right about what SGR 2 IS and wrong about what it MEASURES: a
 * terminal renders it as a fraction of its own foreground, and on Apple
 * Terminal's light profile that lands well under the 4.5:1 floor — the
 * labels, the keys row and the status row were all reported unreadable
 * in real use. An attribute that adapts to an unknown ratio is not a
 * contrast guarantee; the table's measured value is.
 *
 * The UNKNOWN ground keeps SGR 2, because §3.1 forbids an absolute
 * foreground in a palette that has not established a background — the
 * attribute is exactly the "correct on any ground" degradation there.
 */
export const COLOR_NEUTRAL: Palette = withWash("\x1b[7m", "\x1b[27m");
export const COLOR_LIGHT: Palette = withWash("\x1b[48;5;255m", "\x1b[49m", "\x1b[38;5;124m", "\x1b[38;5;243m", "\x1b[38;5;241m");
export const COLOR_DARK: Palette = withWash("\x1b[48;5;236m", "\x1b[49m", "\x1b[38;5;173m", "\x1b[38;5;246m", "\x1b[38;5;247m");
/** The historical name — the palette for a colour TTY whose ground has
 *  not been established. Unchanged in every byte except `code`, which
 *  was the defect. */
export const COLOR_ON: Palette = COLOR_NEUTRAL;
export const COLOR_OFF: Palette = { bold: "", dim: "", red: "", green: "", warn: "", code: "", italic: "", italicEnd: "", underline: "", underlineEnd: "", rv: "", rvEnd: "", wash: "", washEnd: "", washDim: "", washDimEnd: "", lift: "", reset: "" };

/** DC-3 — the resolved ground, set once at startup when the terminal
 *  answers (see `ground.ts`). It starts UNKNOWN and may stay that way
 *  forever; that is a supported state, not a failure. */
let ground: Ground = "unknown";
export function setGround(g: Ground): void {
	ground = g;
}
export function currentGround(): Ground {
	return ground;
}
export function palette(): Palette {
	// PH-1a (finding PH-F5): the no-color.org contract is "present AND
	// non-empty" — the old `=== undefined` check let an EMPTY `NO_COLOR=`
	// (a common shell-profile/CI shape) kill the colors, and through the
	// dock's activation gate (`palette().bold !== ""`) the entire docked
	// UI with them. The v4-round plan recorded this as debugging pitfall ①;
	// it was a bug.
	const noColor = process.env.NO_COLOR;
	if (!((noColor === undefined || noColor === "") && process.stdout.isTTY)) return COLOR_OFF;
	return ground === "light" ? COLOR_LIGHT : ground === "dark" ? COLOR_DARK : COLOR_NEUTRAL;
}

/**
 * E group/round 8: strip terminal-injection vectors from MODEL/TOOL text before it
 * reaches the terminal — ESC, C0 (except \t \n), C1, CR, backspace, and
 * bidi overrides. The kiso colors are applied by render, not by the data.
 * EVERY externally-sourced string must pass through this before any output.
 */
export function escapeTerminal(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text
		.replace(/[\u0000-\u0008\u000d\u000e-\u001f\u007f]/g, "") // C0 (keeps only \t and \n)
		.replace(/\u001b/g, "") // ESC
		.replace(/[\u0080-\u009f]/g, "") // C1
		.replace(/[\u202a-\u202e\u2066-\u2069]/g, ""); // bidi
}


/**
 * v2b — one thinking BLOCK folds to ONE dim line: the first 100 chars, a
 * " (… /think shows full)" marker when the block is longer. The consumer
 * buffers the block's deltas, renders this at the block's end, and keeps
 * the full text for /think. Pipes get the same fold — the content
 * strategy is presentation-independent.
 */
export function foldThinking(block: string): string {
	const p = palette();
	const trimmed = escapeTerminal(block.trim());
	const truncated = trimmed.length > 100;
	return `${p.dim}…${trimmed.slice(0, 100)}${truncated ? ` (${block.length} chars · /think)` : ""}${p.reset}\n`;
}

/** v2b — the [result] echo truncates at 160 chars + a /last hint. */
export function foldResult(content: string): string {
	const flat = content.replaceAll("\n", " ");
	const truncated = flat.length > 160;
	return `${escapeTerminal(flat.slice(0, 160))}${truncated ? " (/last for full)" : ""}`;
}
/**
 * B area: one-line summary of a completed tool call, e.g.
 *   ✓ edit src/foo.ts (+12 -3)    ✓ read src/bar.ts (140 lines)
 *   ✗ shell npm test (exit 1)
 * edit/write show +/- line counts, read shows lines, shell shows the exit
 * code; failures (isError) are ✗. Pure and deterministic.
 */
export function renderToolSummary(
	name: string,
	input: Record<string, unknown>,
	result: { content: string; isError: boolean },
	reason: string | null = null,
): string {
	// v2a/v5: ✓ is a bold identity accent; ✗ stays red.
	const p = palette();
	// W19: a DENIED call (the "denied" tag) renders the pinned row — the
	// FULL call name, the target, the reason in the W4 parentheses idiom,
	// and NO timing metadata (the call never ran — (0.0s) would be noise).
	// The same row in the interactive and pipe paths, byte-clean on a pipe.
	if (reason !== null) {
		return `${p.red}✗${p.reset} ${escapeTerminal(`${name} ${toolTarget(name, input)} (${reason})`)}`;
	}
	const mark = result.isError ? `${p.red}✗${p.reset}` : `${p.bold}✓${p.reset}`;
	const shortName = name.replace("_file", "");
	const detail = toolSummaryDetail(name, input, result);
	return `${mark} ${escapeTerminal(`${shortName} ${detail}`)}`;
}

function toolSummaryDetail(name: string, input: Record<string, unknown>, result: { content: string; isError: boolean }): string {
	// Line count without the phantom empty line after a trailing newline.
	const lines = (text: string): number => {
		if (text === "") return 0;
		const parts = text.split("\n");
		return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
	};
	switch (name) {
		case "read_file": {
			const path = String(input.path ?? "?");
			const count = lines(String(result.content));
			return `${path} (${count} line${count === 1 ? "" : "s"})`;
		}
		case "write_file": {
			const path = String(input.path ?? "?");
			const count = lines(String(input.content ?? ""));
			return `${path} (+${count})`;
		}
		case "edit_file": {
			const path = String(input.path ?? "?");
			const removed = lines(String(input.search ?? ""));
			const added = lines(String(input.replace ?? ""));
			return `${path} (+${added} -${removed})`;
		}
		case "shell": {
			const command = String(input.command ?? "?");
			const exit = exitCodeOf(result);
			return `${command} (exit ${exit})`;
		}
		case "list_dir":
			return String(input.path ?? "(root)");
		default:
			return String(input.path ?? input.command ?? "");
	}
}

/** W15 — the expand header's target: the tool call's subject (the path
 *  for the *_file tools, the command for shell) — the same extraction
 *  the summary detail uses, WITHOUT the counts (the header names what
 *  was expanded, not its size). */
export function toolTarget(name: string, input: Record<string, unknown>): string {
	switch (name) {
		case "read_file":
		case "write_file":
		case "edit_file":
			return String(input.path ?? "?");
		case "shell":
			return String(input.command ?? "?");
		case "list_dir":
			return String(input.path ?? "(root)");
		default:
			return String(input.path ?? input.command ?? "");
	}
}

/** The exit code of a shell result: parsed from the failure text, 0 on success. */
function exitCodeOf(result: { content: string; isError: boolean }): number {
	if (!result.isError) return 0;
	const m = /exit (\d+)/.exec(result.content);
	return m !== null ? Number(m[1]) : 1;
}

/** k-units for the status line: 12345 → 12.3k, 800 → 800, null → ?. */
export function kUnit(value: number | null): string {
	if (value === null) return "?";
	if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	return String(value);
}
/**
 * v2a rhythm — the exact bytes after a terminal event: the status line
 * hugs the terminal (show what there is — omitted when there is nothing to show),
 * then EXACTLY one blank line before the next prompt. The consumer prints
 * this verbatim; the render tests pin the sequence.
 */
export function renderTerminalGap(statusLine: string | null): string {
	return `${statusLine === null ? "" : `${statusLine}\n`}\n`;
}

/**
 * v3 §01 (V6-2) — the banner, block-split. The logo is THREE BRICK rows
 * (the logo.svg pixel form — K I S O), then a BLANK, then the info rows:
 * "kiso vX — tagline" + extensions. The tagline rides the version line
 * (the old logo MIDDLE row was the tagline — a text row masquerading as
 * the logo's centre). Every row truncates at the terminal width with a
 * " (+N)" marker (N = the hidden display width); a window narrower than
 * 40 columns skips the logo + the blank entirely — only the info rows.
 * Pure.
 */
/**
 * design.md §5.2 — THE TWO CYCLES, built. Seven frames each, walked at
 * the existing 200ms spinner cadence, so a waiting screen's byte volume
 * and frame rate are exactly what they were.
 *
 * §5.3 is why neither rotates: "a breath says alive; a turn says
 * counting". A call whose duration cannot be predicted must not wear a
 * mark that implies progress it does not have.
 */

/** The THINKING twinkle — glyphs only, no colour at all, so it survives
 *  NO_COLOR and any ground intact. §4.1: it settles onto `✦`, which is
 *  the same mark the collapsed segment keeps, so nothing new appears at
 *  the transition. Every glyph is in Menlo and absent from Apple Color
 *  Emoji (§6.1's test, run). */
export const TWINKLE = ["\u2727", "\u2726", "\u2736", "\u2738", "\u273a", "\u2738", "\u2726"] as const;

/** The COMMAND breath — brightness only, one glyph. The ramps bottom out
 *  EXACTLY on the ground's dim token (§2.2: "the floor is a floor,
 *  including mid-animation"): light ends at 243 (4.54:1 on white), dark
 *  at 246 (5.50:1 on #1e1e1e). Measured, not assumed. */
const BREATH_LIGHT = [232, 236, 240, 243, 240, 236, 232] as const;
const BREATH_DARK = [255, 251, 248, 246, 248, 251, 255] as const;

/** The breath's frame: `●` at the step's grey, for the CURRENT ground.
 *  With no ground — or under NO_COLOR — it freezes to a static `●`,
 *  because a brightness ramp needs a background to be a ramp against and
 *  §3.1 forbids guessing one. The glyph never changes, so the freeze
 *  degrades the motion and never the meaning. */
export function breathFrame(step: number): string {
	const p = palette();
	const ramp = currentGround() === "light" ? BREATH_LIGHT : currentGround() === "dark" ? BREATH_DARK : null;
	if (ramp === null || p.bold === "") return "\u25cf";
	return `\x1b[38;5;${ramp[step % ramp.length]}m\u25cf${p.reset}`;
}

/** The twinkle's frame — pure glyph, no palette involved. */
export function twinkleFrame(step: number): string {
	return TWINKLE[step % TWINKLE.length]!;
}

/** Both cycles are seven frames, so ONE counter walks them and the two
 *  marks stay in step on a screen showing both. */
export const MOTION_FRAMES = 7;

/** DC-18: the display-width prefix of PLAIN text. `widthCut` lives in
 *  components.ts, which imports this module — the dependency runs one
 *  way, so the four lines live here rather than inverting it. */
function plainCut(text: string, max: number): string {
	let w = 0;
	let i = 0;
	for (; i < text.length; i += 1) {
		const cw = charWidth(text.codePointAt(i)!);
		if (w + cw > max) break;
		w += cw;
	}
	return text.slice(0, i);
}

export const TAGLINE = "the coding agent that survives kill -9";
/**
 * R2 — the wordmark is retired (2026-08-27, the nineteen-screen review).
 *
 * TT-1B had already cut the 36x6 pixel art down to two rows because a
 * tall banner's mid-scroll cut state renders as glyph garbage. The
 * remaining two rows go now for a different reason: they say the word
 * `kiso` in fifteen columns of block glyphs, and the word `kiso` says it
 * in four. A rendered clover mark was tried first, at 4x2, 10x5, 14x7
 * and 16x8, and rejected on measurement — below fourteen columns the
 * centre star closes and the mark reads as a domino, and at fourteen it
 * costs seven rows.
 *
 * What takes the room is not decoration. A first screen is asked three
 * questions — what model, where am I, what is loaded — and it now
 * answers them in one aligned column.
 */
/** R2 — the keys a first screen teaches. One dim row, and deliberately
 *  NOT derived from KEY_BINDINGS: the sheet is the complete list and
 *  this is the opening's five, chosen rather than generated. */
// R2: the keys row names bindings the product ACTUALLY has. The first
// draft advertised `! bash` — there is no bang passthrough in kiso and
// KEY_BINDINGS never had one, so the opening screen was teaching a key
// that does nothing. A first screen that lies is worse than a short one.
const BANNER_KEYS = "esc interrupt · ctrl+c exit · / commands · @ files · ? keys";
/** R2 — the labels. Uppercase mono, dim, letter-spaced by the column
 *  rather than by SGR: they mark sections and are never content. */
const BANNER_LABELS = ["MODEL", "WORKSPACE", "EXTENSIONS"] as const;
const LABEL_STOP = Math.max(...BANNER_LABELS.map((l) => l.length)) + 2;

/** R2 — what the opening knows about the session. Optional because the
 *  off-TTY caller prints a banner before a model is bound. */
export interface BannerMeta {
	readonly model: string;
	readonly mode: string;
	readonly cwd: string;
}

/** v3 §01 (W1): truncate a row at `width`, marking the hidden span
 *  " (+N)". W1: the width math is the charWidth authority (the banner's
 *  brick glyphs are 1 cell — the art's 38 columns clear 40), and the
 *  marker's own cells are part of the row — the visible cut leaves room
 *  for it, so a truncated row never exceeds W (a cut row carries the
 *  marker INSIDE the width; a row that fits is returned untouched). */
export function truncateRow(row: string, width: number): string {
	const total = displayWidth(row);
	if (total <= width) return row;
	// DC-18: a width too narrow to HOLD the marker gets a hard cut. The
	// fixpoint below floors `cut` at 0 and then appends a 6-cell marker
	// regardless, so every width ≤ 6 returned a row WIDER than the
	// terminal — and invariant ① throws rather than truncating. A marker
	// wider than the row it marks is not a marker.
	if (width < 7) return plainCut(row, Math.max(0, width));
	// iterate the marker to a fixpoint: the marker's width changes the
	// cut, the cut changes the hidden count the marker reports
	let marker = " (+0)";
	for (;;) {
		const cut = Math.max(0, width - displayWidth(marker));
		let w = 0;
		let i = 0;
		while (i < row.length) {
			const cp = row.codePointAt(i)!;
			const cw = charWidth(cp);
			if (w + cw > cut) break;
			w += cw;
			i += cp > 0xffff ? 2 : 1; // code-point stepping — never split a pair
		}
		const next = ` (+${total - w})`;
		if (next === marker) return `${row.slice(0, i)}${next}`;
		marker = next;
	}
}

/** v3 §01 (V6-2) + W1: the banner lines for a width W and height H —
 *  the tier table (extends the existing "under 40 columns, skip the
 *  logo" rule with a HEIGHT input; VD-14 merged the two art tiers):
 *    W ≥ 40 and H ≥ 14 → the 2-row wordmark, 2-column indent
 *    anything smaller → text rows only
 *  then the blank, then "vX — tagline" — the art IS the wordmark, so the
 *  text row does not repeat the name — then extensions — then the W5
 *  resume list (BIG only, W5). Every row truncates at the terminal width
 *  with a " (+N)" marker. Pure. */
export function bannerLines(W: number, H: number, version: string, extensionsText: string, resume: readonly ResumeMeta[] = [], now = Date.now(), meta?: BannerMeta | undefined): string[] {
	const p = palette();
	// R2: the banner styles itself per span. It used to be wrapped in one
	// blanket dim by its component, which made the answers as faint as the
	// labels asking the questions — the labels are the quiet half, the
	// values are what a human came to read.
	//
	// Every width decision below is taken on PLAIN text and the styling is
	// applied after, because truncateRow measures with displayWidth, which
	// counts SGR bytes as columns. Style then measure is a bug waiting.
	// DC-18: the name row is CUT like every other row here. It was the one
	// row in this function pushed unguarded, so at W ≤ 10 `kiso 0.16.4`
	// measured 11 cells and invariant ① threw AT STARTUP — the function
	// whose own comment preaches "invariant ① holds at every width".
	// The cut is taken on the plain text, per the note above.
	const namePlain = plainCut(`kiso ${version}`, Math.max(1, W));
	const nameCut = namePlain.slice(0, 4); // "kiso", or its surviving prefix
	const verCut = namePlain.slice(5); // the version, if the width left room for it
	const rows: string[] = [`${p.bold}${nameCut}${p.reset}${verCut === "" ? "" : `${p.dim} ${verCut}${p.reset}`}`];
	const facts: [string, string][] = [];
	if (meta !== undefined) {
		facts.push([BANNER_LABELS[0], `${meta.model}${meta.mode === "" ? "" : ` · ${meta.mode}`}`], [BANNER_LABELS[1], meta.cwd]);
	}
	if (extensionsText !== "") facts.push([BANNER_LABELS[2], extensionsText]);
	if (facts.length > 0) {
		rows.push("");
		// The value column HANGS rather than truncating. The label costs
		// columns the value used to have, and an extension list cut at the
		// width would hide which extensions loaded — on the one screen whose
		// job is to say what is loaded.
		const indent = 2 + LABEL_STOP;
		// a terminal too narrow to hold the label column at all: the room is
		// what is left, floored at one column, and the assembled row is
		// truncated as a unit so invariant ① holds at every width.
		const room = Math.max(1, W - indent);
		for (const [label, value] of facts) {
			const lead = `  ${p.dim}${label}${p.reset}${" ".repeat(LABEL_STOP - label.length)}`;
			const hang = " ".repeat(indent);
			const lines: string[] = [];
			let line = "";
			for (const word of value.split(" ")) {
				if (line === "") line = word;
				else if (displayWidth(`${line} ${word}`) <= room) line += ` ${word}`;
				else {
					lines.push(line);
					line = word;
				}
			}
			if (line !== "") lines.push(line);
			for (const [i, l] of lines.entries()) {
				const styled = `${i === 0 ? lead : hang}${truncateRow(l, room)}`;
				rows.push(displayWidth(styled) - (i === 0 ? p.dim.length + p.reset.length : 0) <= W ? styled : truncateRow(`${hang}${l}`, W));
			}
		}
	}
	if (meta !== undefined && W >= 40) {
		// R2/DC-2's device: the keys row is a list of independent clauses,
		// so a narrow terminal drops whole clauses from the end rather than
		// cutting one in half. `ctrl+o ex (+8)` teaches nothing.
		const clauses = BANNER_KEYS.split(" \u00b7 ");
		let keys = clauses[0]!;
		for (let n = clauses.length; n > 1; n -= 1) {
			const row = clauses.slice(0, n).join(" \u00b7 ");
			if (displayWidth(row) <= W - 2) {
				keys = row;
				break;
			}
		}
		rows.push("", `  ${p.dim}${truncateRow(keys, W - 2)}${p.reset}`);
	}
	if (W >= 40 && H >= 20 && resume.length > 0) {
		rows.push("", ...renderResumeList(resume, W, now));
	}
	return rows;
}

/** W5 — the opening-screen resume list. Every field already exists
 *  behind renderSessionLine / `kiso sessions`: the relative time, the
 *  title, then the right-aligned "N events · M runs". The columns are
 *  fixed per W: 4 indent + 7 when + 1 + the title (the ONLY flexible
 *  field — cut with the ellipsis marker INSIDE the width) + 1 + the meta
 *  (padStart to metaW). The done-when: the meta's right edge lands at
 *  exactly W on every row. Returns PLAIN rows — the banner's uniform dim
 *  wrap styles them (no dim+bold SGR composition). */
export interface ResumeMeta {
	readonly title: string;
	readonly events: number;
	readonly runs: number;
	readonly updatedAt: number;
	/** TT-1B (W5 unification) — the ONE-CELL badge glyph from the
	 *  picker's BADGE_GLYPH vocabulary, derived by the caller from the
	 *  SAME projection the picker uses (session-cards — one source of
	 *  truth about durability). Plain: the banner's uniform dim wrap
	 *  styles the row; the picker keeps color on its own surface.
	 *  Absent on every meta → the pre-TT-1B bytes, verbatim. */
	readonly badge?: string;
}

export function relativeTime(updatedAt: number, now: number): string {
	const s = Math.max(0, now - updatedAt) / 1000;
	if (s < 60) return "now";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 7) return `${d}d ago`;
	return `${Math.floor(d / 7)}w ago`;
}

function titleCut(text: string, max: number): string {
	if (displayWidth(text) <= max) return text;
	const room = max - displayWidth("…");
	let w = 0;
	let i = 0;
	while (i < text.length) {
		const cp = text.codePointAt(i)!;
		const cw = charWidth(cp);
		if (w + cw > room) break;
		w += cw;
		i += cp > 0xffff ? 2 : 1;
	}
	return text.slice(0, i) + "…";
}

export function renderResumeList(metas: readonly ResumeMeta[], W: number, now: number): string[] {
	if (metas.length === 0) return [];
	const rows = ["  ✦ resume"]; // R2: the ONE fold/segment mark (§4.2)
	const whens = metas.map((m) => relativeTime(m.updatedAt, now));
	const metaTexts = metas.map((m) => `${m.events} events · ${m.runs} runs`);
	const metaW = Math.max(...metaTexts.map((t) => t.length));
	// TT-1B (W5): the glyph column exists only when a badge is present —
	// a badge-less list keeps its exact pre-TT-1B bytes; in a mixed list
	// every row reserves the column so the when/title columns never shift.
	const badged = metas.some((m) => m.badge !== undefined);
	const titleW = Math.max(1, W - (badged ? 15 : 13) - metaW);
	for (let i = 0; i < metas.length; i += 1) {
		const title = escapeTerminal(metas[i]!.title);
		const shown = titleCut(title, titleW);
		const pad = titleW - displayWidth(shown);
		const glyph = badged ? `${metas[i]!.badge ?? " "} ` : "";
		rows.push(`    ${glyph}${whens[i]!.padEnd(7)} ${shown}${" ".repeat(pad)} ${metaTexts[i]!.padStart(metaW)}`);
	}
	return rows;
}
