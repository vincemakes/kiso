/**
 * tui-cells — the render slice (ADR-0043 Amendment 4): the
 * cell-rendering helpers components.ts imports — moved verbatim from
 * the tui's render.ts, never duplicated. Pure (testable): given text,
 * produce the bytes a human sees. Colors are raw ANSI — zero
 * dependencies (the tui-cells package has none).
 */

import { charWidth, displayWidth, visibleWidth, widthCut } from "./width.js";
import type { Ground, Rgb } from "./ground.js";
import { bg, breathRamp, colourTier, fg, graphiteColours, mix, type Tier } from "./graphite.js";

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
	/** Graphite (design.md §2) — the tokens the redesign reads. Each is an
	 *  SGR open for its colour in the resolved tier (§2: 24-bit or the
	 *  nearest xterm-256 index), and EMPTY where the ground is unknown or
	 *  colour is off: §3.1 forbids an absolute colour on a ground nobody
	 *  established, so every one of them degrades to the terminal's own.
	 *  Foregrounds close with `fgEnd` (39), backgrounds with `washEnd`
	 *  (49), for the reason `rv` closes with 27. */
	readonly ink2: string;
	readonly rail: string;
	readonly line: string;
	readonly gold: string;
	readonly goldMark: string;
	readonly blue: string;
	readonly ok: string;
	readonly fail: string;
	readonly humanInk: string;
	readonly track: string;
	readonly washRun: string;
	readonly washDone: string;
	readonly washFail: string;
	readonly washAsk: string;
	readonly human: string;
	readonly codeBg: string;
	readonly add: string;
	readonly del: string;
	/** The half-row pads (`▄` above a block, `▀` below it) are GLYPHS in
	 *  the surface's colour on the terminal's own ground, so each padded
	 *  surface has a foreground twin (design.md §7.4, §7.9). */
	readonly humanPad: string;
	readonly washRunPad: string;
	readonly washDonePad: string;
	readonly washFailPad: string;
	readonly washAskPad: string;
	/** Graphite §7.8 — the drawn caret: a gold cell (text on it in the dark
	 *  ink); closed with 49 and 39. Empty where the ground is unknown — the
	 *  caret is reverse video there. */
	readonly caret: string;
	readonly caretEnd: string;
	readonly fgEnd: string;
	/** §5.2 — the command breath's seven foreground opens; empty where
	 *  the mark freezes (no ground, or no colour). */
	readonly breath: readonly string[];
	/** The tier the colours were written in, or null when none were. */
	readonly tier: Tier | null;
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
 * Its values are Graphite's `fail` (design.md §2), written in the
 * resolved tier.
 *
 * With NO ground established the token stays ANSI 31 — the TERMINAL's
 * own red, which its theme picked for its own background. That is the last rung
 * 4's principle exactly: when the ground is unknown, use the thing that
 * is correct on any ground rather than guessing one.
 */
/** `washDimEnd` is DERIVED, never passed: a grey that cannot be closed
 *  without taking the wash with it is not a usable token, and deriving
 *  the close makes the pair impossible to mis-wire at a call site. */
/** The Graphite members, empty — the unknown ground's and colour-off's. */
const NO_GRAPHITE = {
	ink2: "",
	rail: "",
	line: "",
	gold: "",
	goldMark: "",
	blue: "",
	ok: "",
	fail: "",
	humanInk: "",
	track: "",
	washRun: "",
	washDone: "",
	washFail: "",
	washAsk: "",
	human: "",
	codeBg: "",
	add: "",
	del: "",
	humanPad: "",
	washRunPad: "",
	washDonePad: "",
	washFailPad: "",
	washAskPad: "",
	caret: "",
	caretEnd: "",
	fgEnd: "",
	breath: [],
	tier: null,
} as const;
const withWash = (wash: string, washEnd: string, red: string = BASE.red, dim: string = BASE.dim, washDim = ""): Palette => ({
	...BASE,
	...NO_GRAPHITE,
	red,
	dim,
	wash,
	washEnd,
	washDim,
	washDimEnd: washDim === "" ? "" : "\x1b[39m",
	code: wash,
});

/**
 * Graphite (design.md §2, §3.4) — the palette for a KNOWN ground.
 *
 * The colours come from `graphite.ts`: the table's values for the kind,
 * with the surfaces derived from the reported ground when there is one.
 * The members the pre-Graphite code reads keep their names and take the
 * Graphite value of the same job: `dim` the dim token, `red` the failure
 * colour, `green` the success colour, `warn` gold (the uncertain badge
 * is a question for the person, which is gold's meaning), `wash` the
 * settled card's ground, and `washDim` the dim token — which clears the
 * floor on every card ground (§2.1), so the separate grey retires in
 * value while the name stays for its call sites.
 */
export function paletteFor(kind: "light" | "dark", ground: Rgb | null, tier: Tier): Palette {
	const c = graphiteColours(kind, ground, tier);
	const f = (x: Rgb): string => fg(x, tier);
	const b = (x: Rgb): string => bg(x, tier);
	return {
		...BASE,
		dim: f(c.dim),
		red: f(c.fail),
		green: f(c.ok),
		warn: f(c.gold),
		wash: b(c.washDone),
		washEnd: "\x1b[49m",
		washDim: f(c.dim),
		washDimEnd: "\x1b[39m",
		code: b(c.washDone),
		ink2: f(c.ink2),
		rail: f(c.rail),
		line: f(c.line),
		gold: f(c.gold),
		goldMark: f(c.goldMark),
		blue: f(c.blue),
		ok: f(c.ok),
		fail: f(c.fail),
		humanInk: f(c.humanInk),
		track: f(c.track),
		washRun: b(c.washRun),
		washDone: b(c.washDone),
		washFail: b(c.washFail),
		washAsk: b(c.washAsk),
		human: b(c.human),
		codeBg: b(c.code),
		add: b(c.add),
		del: b(c.del),
		humanPad: f(c.human),
		washRunPad: f(c.washRun),
		washDonePad: f(c.washDone),
		washFailPad: f(c.washFail),
		washAskPad: f(c.washAsk),
		caret: `${b(c.goldMark)}${f(c.humanInk)}`,
		caretEnd: "\x1b[49m\x1b[39m",
		fgEnd: "\x1b[39m",
		breath: breathRamp(c).map(f),
		tier,
	};
}
/**
 * DC-3 — one table per ground.
 *
 * R3 (owner, 2026-08-27) — `dim` is ABSOLUTE once the ground is known:
 * Graphite's `dim`, measured against the floor on every surface it can
 * reach (design.md §2.1).
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
/** The two reference palettes: Graphite on its reference grounds, in the
 *  24-bit tier. `paletteFor` is the general form. */
export const COLOR_LIGHT: Palette = paletteFor("light", null, "24bit");
export const COLOR_DARK: Palette = paletteFor("dark", null, "24bit");
/** The historical name — the palette for a colour TTY whose ground has
 *  not been established. Unchanged in every byte except `code`, which
 *  was the defect. */
export const COLOR_ON: Palette = COLOR_NEUTRAL;
export const COLOR_OFF: Palette = { bold: "", dim: "", red: "", green: "", warn: "", code: "", italic: "", italicEnd: "", underline: "", underlineEnd: "", rv: "", rvEnd: "", wash: "", washEnd: "", washDim: "", washDimEnd: "", reset: "", ...NO_GRAPHITE };

/** DC-3 — the resolved ground, set once at startup when the terminal
 *  answers (see `ground.ts`). It starts UNKNOWN and may stay that way
 *  forever; that is a supported state, not a failure. */
let ground: Ground = "unknown";
/** §3.4 — the colour the terminal reported, when it reported one; the
 *  surfaces are derived from it. Null when the ground was resolved
 *  without a colour. */
let groundRgb: Rgb | null = null;
export function setGround(g: Ground, rgb: Rgb | null = null): void {
	ground = g;
	groundRgb = g === "unknown" ? null : rgb;
}
export function currentGround(): Ground {
	return ground;
}
export function currentGroundRgb(): Rgb | null {
	return groundRgb;
}
/** One palette per (ground, reported colour, tier): `palette()` runs on
 *  every render and the derivation is not free, so the last answer is
 *  kept and reused while none of its inputs changed. */
let memo: { key: string; p: Palette } | null = null;
export function palette(): Palette {
	// PH-1a (finding PH-F5): the no-color.org contract is "present AND
	// non-empty" — the old `=== undefined` check let an EMPTY `NO_COLOR=`
	// (a common shell-profile/CI shape) kill the colors, and through the
	// dock's activation gate (`palette().bold !== ""`) the entire docked
	// UI with them. The v4-round plan recorded this as debugging pitfall ①;
	// it was a bug.
	const noColor = process.env.NO_COLOR;
	if (!((noColor === undefined || noColor === "") && process.stdout.isTTY)) return COLOR_OFF;
	if (ground === "unknown") return COLOR_NEUTRAL;
	const tier = colourTier(process.env.COLORTERM);
	const key = `${ground}|${groundRgb === null ? "-" : `${groundRgb.r},${groundRgb.g},${groundRgb.b}`}|${tier}`;
	if (memo === null || memo.key !== key) memo = { key, p: paletteFor(ground, groundRgb, tier) };
	return memo.p;
}

/**
 * E group/round 8: strip terminal-injection vectors from MODEL/TOOL text before it
 * reaches the terminal — ESC, C0 (except \t \n), C1, CR, backspace, and
 * bidi overrides. The kiso colors are applied by render, not by the data.
 * EVERY externally-sourced string must pass through this before any output.
 */
/**
 * 0.40.0 (the owner's dogfood) — a tool's OUTPUT, shown without its
 * terminal styling. escapeTerminal drops the ESC byte and nothing else, so
 * a coloured test run reached the card as `[31m─── [1m[41m Failed Tests`.
 * Here the whole sequence goes: CSI (colours, cursor moves), OSC (titles,
 * links), DCS/SOS/PM/APC strings, charset selections, the two-byte escapes,
 * and the 8-bit CSI. Every branch is linear: a string body stops at the
 * first ESC (only its terminator may hold one), so hostile output — an
 * unterminated `ESC P` repeated — never scans to the end of the text once
 * per sequence (the lead's review: that was n²/2 on the render path).
 * Only output bodies pass through here — in a NAME the
 * `[31m` remnant is the visible sign of an injected sequence, and stripping
 * it would let `sh<ESC>[31mell` read as `shell`.
 */
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[ -/]+[0-~]|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_SEQUENCE, "");
}

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
	// the PIPE's line: no room limit, so the row path below reproduces
	// today's bytes exactly and this stays the one source of the shape.
	return `${foldThinkingRow(block, Number.POSITIVE_INFINITY)}\n`;
}

/** §2.3 — the same fold, as a ROW that fits `room` columns.
 *
 *  A row must measure ≤ W (invariant ①), and the pipe's line does not:
 *  `…` + 100 characters + " (N chars · /think)" is about 122 columns, so
 *  on an 80-column terminal the frame's cut takes the SUFFIX — which is
 *  the affordance, the one part of a folded block that says how to read
 *  the rest of it. Cutting from the right removes exactly the thing the
 *  fold exists to leave behind.
 *
 *  So the suffix is reserved FIRST and the head takes what is left. The
 *  vocabulary is unchanged — the leading `…`, the character count, the
 *  `/think` route — and with unlimited room the result is byte-for-byte
 *  the line the pipe has always written, which is what keeps the two
 *  renderings one shape rather than two. */
export function foldThinkingRow(block: string, room: number): string {
	const p = palette();
	const trimmed = escapeTerminal(block.trim());
	const truncated = trimmed.length > 100;
	const suffix = truncated ? ` (${block.length} chars · /think)` : "";
	const head = Number.isFinite(room)
		? // the leading … costs one column, the suffix costs its own width
			widthCut(trimmed.slice(0, 100), Math.max(1, room - 1 - displayWidth(suffix)))
		: trimmed.slice(0, 100);
	return `${p.dim}…${head}${suffix}${p.reset}`;
}

/**
 * DC-60 (0.32.2) — the words of a turn, whatever shape its content took.
 *
 * A turn that carries an image is an ARRAY of blocks (text, image, text…)
 * in the durable log. Its echo — the user chip while the session runs, the
 * transcript's replay, the session listing — must say the words and mark
 * the image, and it must say them from ONE definition: the live echo used
 * to pass a string through and an array became an empty chip, while the
 * transcript path projected the array on its own. The image mark is
 * "(image)"; the bytes are never shown.
 */
export function echoText(content: string | readonly { readonly type?: string; readonly text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.map((b) => (b.type === "text" ? (b.text ?? "") : "(image)"))
		.join(" ")
		.replace(/ +/g, " ")
		.trim();
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
	const detail = oneRow(toolSummaryDetail(name, input, result)); // HF-1: one row, whatever the command
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
		case "list_dir": {
			// "(root)" already answered an ABSENT path. A model that sends
			// "." explicitly is making the same request and was getting the
			// dot on the row. `./` likewise. Anything else — including `..`
			// and a dotfile directory like `.github` — is a real path.
			const dir = String(input.path ?? ".");
			return dir === "." || dir === "./" ? "(root)" : dir;
		}
		case "search_text":
			return searchSubject(input);
		default:
			return String(input.path ?? input.command ?? "");
	}
}

/** W15 — the expand header's target: the tool call's subject (the path
 *  for the *_file tools, the command for shell) — the same extraction
 *  the summary detail uses, WITHOUT the counts (the header names what
 *  was expanded, not its size). */
export function toolTarget(name: string, input: Record<string, unknown>): string {
	return oneRow(toolTargetRaw(name, input));
}

/**
 * HF-1 (0.32.1) — a head row is ONE row, whatever the model wrote.
 *
 * The owner's 0.32.0 dogfood: the model issued a heredoc shell command
 * (`python3 - <<'EOF' …`), the running card's head carried its newlines
 * into the compositor, invariant ①b threw in the field and the process
 * died. `escapeTerminal` keeps `\n` on purpose (text blocks need it); a
 * HEAD ROW does not — it is one physical row by construction. So every
 * builder that puts a tool's target on a row projects the breaks to a
 * visible mark first: a line break becomes `⏎` (CRLF is one), a tab
 * becomes one cell of space (its width is a property of the column, and
 * a cut row has no column to give it). The full command is still on the
 * approval panel and in the durable log; the row says what ran, in one
 * row.
 */
export function oneRow(text: string): string {
	return text.replace(/\r\n|\n|\r/g, "\u23ce").replace(/\t/g, " ");
}

function toolTargetRaw(name: string, input: Record<string, unknown>): string {
	switch (name) {
		case "read_file":
		case "write_file":
		case "edit_file":
			return String(input.path ?? "?");
		case "shell":
			return String(input.command ?? "?");
		case "list_dir": {
			// "(root)" already answered an ABSENT path. A model that sends
			// "." explicitly is making the same request and was getting the
			// dot on the row. `./` likewise. Anything else — including `..`
			// and a dotfile directory like `.github` — is a real path.
			const dir = String(input.path ?? ".");
			return dir === "." || dir === "./" ? "(root)" : dir;
		}
		case "search_text":
			return searchSubject(input);
		default:
			return String(input.path ?? input.command ?? "");
	}
}

/** R13 — a search's subject is WHAT IT LOOKED FOR. The schema is
 *  `pattern` (required) + `path` (optional), and both switches here fell
 *  through to the default, which reads `path` — so a search of the whole
 *  tree had an EMPTY head row, and one scoped to a directory named the
 *  directory instead of the pattern. The scope is a fact too, so it
 *  rides behind: `search TODO · src`. */
function searchSubject(input: Record<string, unknown>): string {
	const pattern = String(input.pattern ?? input.query ?? "");
	const path = input.path === undefined || input.path === null || input.path === "" ? "" : String(input.path);
	if (pattern === "") return path;
	return path === "" ? pattern : `${pattern} · ${path}`;
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

/**
 * Graphite §7.8 — the composer's top rule: `gold-mark` for its first eighth,
 * fading to `line` by a third of the width, `line` after. Drawn in a
 * handful of runs, not a colour per cell, so the row costs a few escapes
 * rather than one per column. Off a known ground it is the plain dim rule.
 */
export function fadeRule(W: number): string {
	const p = palette();
	const n = Math.max(0, W);
	if (p.tier === null || ground === "unknown") return `${p.dim}${"\u2500".repeat(n)}${p.reset}`;
	const c = graphiteColours(ground, groundRgb, p.tier);
	const solid = Math.max(1, Math.round(n / 8));
	const end = Math.max(solid + 1, Math.round(n / 3));
	const STEPS = 6;
	let out = `${fg(c.goldMark, p.tier)}${"\u2500".repeat(Math.min(n, solid))}`;
	let at = solid;
	for (let k = 1; k <= STEPS && at < Math.min(n, end); k += 1) {
		const to = k === STEPS ? Math.min(n, end) : Math.min(n, solid + Math.round(((end - solid) * k) / STEPS));
		if (to > at) out += `${fg(mix(c.goldMark, c.line, k / (STEPS + 1)), p.tier)}${"\u2500".repeat(to - at)}`;
		at = Math.max(at, to);
	}
	if (at < n) out += `${fg(c.line, p.tier)}${"\u2500".repeat(n - at)}`;
	return `${out}${p.fgEnd}`;
}

/** The breath's frame: `●` at the step's brightness (§5.2 — seven steps
 *  of gold toward the running card's ground, never under the graphic
 *  floor, `graphite.ts` `breathRamp`). With no ground — or under
 *  NO_COLOR — it freezes to a static `●`, because a brightness ramp needs
 *  a background to be a ramp against and §3.1 forbids guessing one. The
 *  glyph never changes, so the freeze degrades the motion and never the
 *  meaning. */
export function breathFrame(step: number): string {
	const p = palette();
	if (p.breath.length === 0) return "\u25cf";
	return `${p.breath[step % p.breath.length]}\u25cf${p.reset}`;
}

/** The twinkle's frame — pure glyph, no palette involved. */
export function twinkleFrame(step: number): string {
	return TWINKLE[step % TWINKLE.length]!;
}

/** Both cycles are seven frames, so ONE counter walks them and the two
 *  marks stay in step on a screen showing both. */
export const MOTION_FRAMES = 7;

export const TAGLINE = "the coding agent that survives kill -9";
/**
 * Graphite §7.10 — the opening: the wordmark, then what loaded.
 *
 * DECLARED REVERSAL (Graphite, owner-ruled 2026-09-28) of R2's "no logo,
 * the name is the mark". R2 retired the wordmark because it cost the rows
 * a first screen needed for three questions — what model, where am I, what
 * is loaded. The model and the folder moved to the status bar (§8.9), what
 * is loaded moved beside the wordmark, and the wordmark came back: ten
 * rows, once, at the top of a session. Under 30 rows, on a terminal too
 * narrow for it, and on a resume (the history is above the opening there,
 * and ten rows of wordmark would bury its tail) the opening is one line.
 *
 * The R2 keys row retires with it: the empty input carries the key ladder
 * now (§7.8), so the opening does not teach keys a second time.
 */
export const MOTTO = "intent \u2192 effect \u2192 durable fact";
const WORDMARK = [
	"\u2588\u2588\u2557  \u2588\u2588\u2557\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2557",
	"\u2588\u2588\u2551 \u2588\u2588\u2554\u255d\u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d\u2588\u2588\u2554\u2550\u2550\u2550\u2588\u2588\u2557",
	"\u2588\u2588\u2588\u2588\u2588\u2554\u255d \u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2551   \u2588\u2588\u2551",
	"\u2588\u2588\u2554\u2550\u2588\u2588\u2557 \u2588\u2588\u2551\u255a\u2550\u2550\u2550\u2550\u2588\u2588\u2551\u2588\u2588\u2551   \u2588\u2588\u2551",
	"\u2588\u2588\u2551  \u2588\u2588\u2557\u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551\u255a\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255d",
	"\u255a\u2550\u255d  \u255a\u2550\u255d\u255a\u2550\u255d\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u255d \u255a\u2550\u2550\u2550\u2550\u2550\u255d",
] as const;
/** The wordmark's width in cells (its widest row). */
export const WORDMARK_W = Math.max(...WORDMARK.map((r) => displayWidth(r)));
/** The content edge (§1.8) the opening's rows start at. */
const OPENING_EDGE = 4;
/** §7.10: the facts sit beside the wordmark from this width, below it under. */
const FACTS_BESIDE_W = 96;
/** §7.10: under this height the opening is one line. */
const OPENING_TALL_H = 30;
/** The facts' label column: the longest label and two spaces. */
const FACT_LABEL_W = "EXTENSIONS".length + 2;

/** One fact the opening states: its label, the fact, and a quieter note
 *  after it. An empty label continues the fact above it. */
export interface BannerFact {
	readonly label: string;
	readonly value: string;
	readonly note?: string;
}

/** §7.10 — what the opening knows: what loaded (the CLI composes the
 *  facts; this module only lays them out), and whether the session was
 *  resumed (a resumed session opens on the one-line form). */
export interface BannerMeta {
	readonly facts: readonly BannerFact[];
	readonly resumed?: boolean;
}

/** W20 — the ONE-ROW cut with the honest mark, SGR-aware. A line that
 *  fits (≤ W) passes through whole; an overflow cuts the content at
 *  W−1 — the ellipsis's slot — and the ellipsis rides AFTER the reset
 *  (post-reset — the PTY needles' convention). The cut row never
 *  exceeds W (invariant ①). One implementation for every one-row
 *  surface: the live task rows, the approval panel's lines (W21), the
 *  help and keys rows, the transcript viewer's rows. (The strings module
 *  and the viewer each carried a copy; the viewer's put the ellipsis
 *  before the reset, and now does not.) */
export function cutLine(line: string, W: number): string {
	if (visibleWidth(line) <= W) return line;
	let out = "";
	let width = 0;
	for (let i = 0; i < line.length; ) {
		if (line[i] === "\x1b") {
			// exec returns an ARRAY — copying m coerces it (the match), but
			// m.length is the CAPTURE count (1), not the sequence length:
			// the old `i += m.length` re-processed the sequence's bracket
			// text as literal rows, doubling every code in a cut line
			// (the W21 panel-slot red test). Index 0 is the sequence.
			const m = /^\x1b\[[0-9;]*m/.exec(line.slice(i))?.[0] ?? line[i]!;
			out += m;
			i += m.length;
			continue;
		}
		const cw = displayWidth(line[i]!);
		if (width + cw > W - 1) break; // reserve the ellipsis's column
		out += line[i]!;
		width += cw;
		i += 1;
	}
	// R8a: the reset comes from the PALETTE, not hardcoded. `\x1b[0m`
	// here put an escape into every cut row under NO_COLOR and behind a
	// pipe — the one context COLOR_OFF exists to keep clean (§1.2). A
	// coloured palette is byte-identical, because its reset IS `\x1b[0m`.
	return `${out}${palette().reset}…`;
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
	if (width < 7) return widthCut(row, Math.max(0, width));
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

/**
 * Graphite §7.10 — the opening's rows for a width W and height H. Pure;
 * invariant ① holds at every width (each row is cut to W).
 *
 *  - The tall form (H ≥ 30, W ≥ the wordmark at the content edge, not a
 *    resume): the wordmark, its rule, the tagline with the version, the
 *    motto. The facts sit beside it behind one hairline when W ≥ 96, and
 *    below it otherwise.
 *  - The one-line form otherwise: `✦ kiso <version> · <tagline>`, the
 *    facts below it.
 *
 * On a known ground the block cells take `mix(ink, dim, row / 4)` top to
 * bottom, the box-drawing shadow `mix(rail, ground, 0.35)`, and the rule
 * fades from `dim` to the ground; there is no gold (§1.2 — gold is the
 * edge, and the opening has none). Off one the wordmark is the terminal's
 * own foreground. `<version>` is the caller's, never a literal.
 */
export function bannerLines(W: number, H: number, version: string, extensionsText: string, resume: readonly ResumeMeta[] = [], now = Date.now(), meta?: BannerMeta | undefined): string[] {
	const p = palette();
	const width = Math.max(1, W);
	const cut = (row: string): string => cutLine(row, width);
	const facts: readonly BannerFact[] = meta !== undefined ? meta.facts : extensionsText !== "" ? [{ label: "EXTENSIONS", value: extensionsText }] : [];
	const tall = H >= OPENING_TALL_H && width >= OPENING_EDGE + WORDMARK_W && meta?.resumed !== true;
	const pad = " ".repeat(OPENING_EDGE);
	const rows: string[] = [];
	if (!tall) {
		rows.push(cut(`  \u2726 ${p.bold}kiso${p.reset} ${p.dim}${version} \u00b7 ${TAGLINE}${p.reset}`));
		if (facts.length > 0) rows.push("", ...factRows(facts, width - OPENING_EDGE).map((r) => cut(`${pad}${r}`)));
	} else {
		const head = [...wordmarkRows(), openingRule(WORDMARK_W), `${p.ink2}${TAGLINE}${p.fgEnd}${p.dim} \u00b7 ${version}${p.reset}`, `${p.dim}${MOTTO}${p.reset}`];
		// two cells after the wordmark's widest row, the hairline, two more,
		// then the facts
		const factsCol = OPENING_EDGE + WORDMARK_W + 5;
		// beside the wordmark from 96 columns, as long as the facts' rows fit
		// in its six; below it otherwise
		const beside = width >= FACTS_BESIDE_W ? factRows(facts, width - factsCol) : [];
		if (beside.length > 0 && beside.length <= WORDMARK.length) {
			const rule = p.line !== "" ? `${p.line}\u2502${p.fgEnd}` : `${p.dim}\u2502${p.reset}`;
			for (const [i, h] of head.entries()) {
				if (i >= WORDMARK.length) {
					rows.push(cut(`${pad}${h}`));
					continue;
				}
				const gap = " ".repeat(WORDMARK_W + 2 - visibleWidth(h));
				rows.push(cut(`${pad}${h}${gap}${rule}${beside[i] === undefined ? "" : `  ${beside[i]}`}`));
			}
		} else {
			rows.push(...head.map((h) => cut(`${pad}${h}`)));
			if (facts.length > 0) rows.push("", ...factRows(facts, width - OPENING_EDGE).map((r) => cut(`${pad}${r}`)));
		}
	}
	if (W >= 40 && H >= 20 && resume.length > 0) {
		rows.push("", ...renderResumeList(resume, W, now));
	}
	return rows;
}

/** The wordmark's six rows, coloured per §7.10 on a known ground. */
function wordmarkRows(): string[] {
	const p = palette();
	const tier = p.tier;
	if (tier === null || ground === "unknown") return [...WORDMARK];
	const c = graphiteColours(ground, groundRgb, tier);
	const shadow = fg(mix(c.rail, c.ground, 0.35), tier);
	return WORDMARK.map((row, i) => {
		const block = fg(mix(c.ink, c.dim, Math.min(1, i / 4)), tier);
		let out = "";
		let run: "block" | "shadow" | "space" | null = null;
		for (const ch of row) {
			const kind = ch === "\u2588" ? "block" : ch === " " ? "space" : "shadow";
			if (kind !== run && kind !== "space") out += kind === "block" ? block : shadow;
			if (kind !== "space") run = kind;
			out += ch;
		}
		return `${out}${p.fgEnd}`;
	});
}

/** The rule under the wordmark: `dim` fading to the ground, in a few runs.
 *  Off a known ground, the plain dim rule. */
function openingRule(n: number): string {
	const p = palette();
	if (p.tier === null || ground === "unknown") return `${p.dim}${"\u2500".repeat(n)}${p.reset}`;
	const c = graphiteColours(ground, groundRgb, p.tier);
	const STEPS = 7;
	let out = "";
	let at = 0;
	for (let k = 0; k < STEPS && at < n; k += 1) {
		const to = k === STEPS - 1 ? n : Math.round((n * (k + 1)) / STEPS);
		if (to > at) out += `${fg(mix(c.dim, c.ground, k / STEPS), p.tier)}${"\u2500".repeat(to - at)}`;
		at = Math.max(at, to);
	}
	return `${out}${p.fgEnd}`;
}

/** The facts as rows `room` cells wide: the label dim in its column, the
 *  fact in ink, the note dim after it. A row that does not fit loses its
 *  note first; a fact still too long HANGS under itself, folded by word —
 *  an extensions list cut at the width would hide which extensions
 *  loaded, on the one screen whose job is to say so. */
function factRows(facts: readonly BannerFact[], room: number): string[] {
	const p = palette();
	const rows: string[] = [];
	for (const f of facts) {
		const label = `${p.dim}${f.label}${p.reset}${" ".repeat(Math.max(1, FACT_LABEL_W - f.label.length))}`;
		const value = escapeTerminal(f.value);
		const note = f.note === undefined ? "" : escapeTerminal(f.note);
		const whole = `${label}${value}${note === "" ? "" : `${p.dim} \u00b7 ${note}${p.reset}`}`;
		if (visibleWidth(whole) <= room) {
			rows.push(whole);
			continue;
		}
		const valueRoom = room - FACT_LABEL_W;
		if (valueRoom < 8) {
			rows.push(cutLine(`${label}${value}`, Math.max(1, room)));
			continue;
		}
		const lines: string[] = [];
		let line = "";
		for (const word of value.split(" ")) {
			if (line === "") line = word;
			else if (displayWidth(`${line} ${word}`) <= valueRoom) line += ` ${word}`;
			else {
				lines.push(line);
				line = word;
			}
		}
		if (line !== "") lines.push(line);
		const hang = " ".repeat(FACT_LABEL_W);
		for (const [i, l] of lines.entries()) rows.push(cutLine(`${i === 0 ? label : hang}${l}`, Math.max(1, room)));
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
