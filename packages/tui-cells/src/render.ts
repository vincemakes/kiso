/**
 * tui-cells — the render slice (ADR-0043 Amendment 4): the
 * cell-rendering helpers components.ts imports — moved verbatim from
 * the tui's render.ts, never duplicated. Pure (testable): given text,
 * produce the bytes a human sees. Colors are raw ANSI — zero
 * dependencies (the tui-cells package has none).
 */

import { charWidth, displayWidth } from "./width.js";

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
	readonly code: string; // TUI v5 #16e: the inline-code tint — assistant body backtick spans only (KC3 §2: light GRAY, the mono discipline)
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
	readonly rv: string; // W16: reverse video — SGR 7, closed with rvEnd (27, never SGR 0 — the chip composes with a surrounding span)
	readonly rvEnd: string;
	readonly reset: string;
}
export const COLOR_ON: Palette = { bold: "\x1b[1m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", warn: "\x1b[33m", code: "\x1b[38;5;252m", italic: "\x1b[3m", italicEnd: "\x1b[23m", rv: "\x1b[7m", rvEnd: "\x1b[27m", reset: "\x1b[0m" };
export const COLOR_OFF: Palette = { bold: "", dim: "", red: "", green: "", warn: "", code: "", italic: "", italicEnd: "", rv: "", rvEnd: "", reset: "" };
export function palette(): Palette {
	return process.env.NO_COLOR === undefined && process.stdout.isTTY ? COLOR_ON : COLOR_OFF;
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
export const TAGLINE = "the coding agent that survives kill -9";
/** v6's existing logo — W1's COMPACT tier, byte-identical, no redraw. */
const LOGO_ROWS = ["█ █ ▀█▀ █▀▀ █▀█", "█▀▄  █  ▀▀█ █ █", "▀ ▀ ▀▀▀ ▀▀▀ ▀▀▀"] as const;
/** W1's BIG tier (36x6, `█` and space only — no half-blocks, so there is
 *  no tile seam to lose in a font that renders ▀ ▄ at the wrong height).
 *  Each pixel is two cells wide on purpose (a terminal cell is ~1:2);
 *  the render indents two — 38 columns total, clears 40. */
const BIG_LOGO_ROWS = [
	"██    ██  ██████  ████████  ████████",
	"██  ██      ██    ██        ██    ██",
	"████        ██    ████████  ██    ██",
	"████        ██          ██  ██    ██",
	"██  ██      ██          ██  ██    ██",
	"██    ██  ██████  ████████  ████████",
] as const;

/** v3 §01 (W1): truncate a row at `width`, marking the hidden span
 *  " (+N)". W1: the width math is the charWidth authority (the banner's
 *  brick glyphs are 1 cell — the art's 38 columns clear 40), and the
 *  marker's own cells are part of the row — the visible cut leaves room
 *  for it, so a truncated row never exceeds W (a cut row carries the
 *  marker INSIDE the width; a row that fits is returned untouched). */
export function truncateRow(row: string, width: number): string {
	const total = displayWidth(row);
	if (total <= width) return row;
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
 *  logo" rule with a HEIGHT input):
 *    W ≥ 40 and H ≥ 20 → BIG (the 36x6 wordmark, 2-column indent)
 *    W ≥ 40 and 14–19 rows → COMPACT (v6's LOGO_ROWS, byte-identical)
 *    anything smaller → text rows only
 *  then the blank, then "vX — tagline" — the art IS the wordmark, so the
 *  text row does not repeat the name — then extensions — then the W5
 *  resume list (BIG only, W5). Every row truncates at the terminal width
 *  with a " (+N)" marker. Pure. */
export function bannerLines(W: number, H: number, version: string, extensionsText: string, resume: readonly ResumeMeta[] = [], now = Date.now()): string[] {
	const rows: string[] = [];
	if (W >= 40) {
		if (H >= 20) {
			for (const r of BIG_LOGO_ROWS) rows.push(truncateRow(`  ${r}`, W));
		} else if (H >= 14) {
			for (const r of LOGO_ROWS) rows.push(truncateRow(r, W));
		}
	}
	if (rows.length > 0) rows.push("");
	rows.push(truncateRow(`v${version} — ${TAGLINE}`, W));
	if (extensionsText !== "") rows.push(truncateRow(extensionsText, W));
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
	const rows = ["  ▞ resume"];
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
