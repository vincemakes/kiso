/**
 * Event rendering for the terminal. Pure (testable): given the render
 * input, produce the lines a human sees. Colors are raw ANSI — no
 * dependencies.
 *
 * the ergonomics batch C5: the input is the tui's OWN data shape (RenderInput), never
 * kiso-core's Event — the CLI translates Event → RenderInput. The tui
 * package has ZERO kiso-core imports: input is data, output is bytes.
 */

import { charWidth, displayWidth } from "./width.js";

/**
 * v2a — the palette, centralized (no hard-coded codes elsewhere); v5
 * (TUI v5 #16e, the v4.1 design): the decorative blue (38;5;75) is
 * RETIRED — the identity accents (the you> prompt, the banner tagline,
 * ✓ marks, slash-command names, the input brick) are bright-white BOLD
 * (SGR 1); the user message is the SGR-7 chip (the 2026-08-09 ruling
 * retired the ▍ rail); `code` is the content semantic tint for
 * inline code spans in assistant text (256-color 110 — the cube color
 * nearest the design's #8fb4d8); red for errors, dim for metadata,
 * green for the diff additions. NO_COLOR set, or a non-TTY output →
 * every code is empty, so pipes and CI carry ZERO ANSI (the existing
 * byte-level e2e assertions guard it). Everything not listed is plain.
 */
export interface Palette {
	readonly bold: string;
	readonly dim: string;
	readonly red: string;
	readonly green: string; // v2e: the diff additions — diff-only (NO_COLOR falls back to the + prefix)
	readonly code: string; // TUI v5 #16e: the inline-code tint — assistant body backtick spans only
	readonly rv: string; // W16: reverse video — SGR 7, closed with rvEnd (27, never SGR 0 — the chip composes with a surrounding span)
	readonly rvEnd: string;
	readonly reset: string;
}
export const COLOR_ON: Palette = { bold: "\x1b[1m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", code: "\x1b[38;5;110m", rv: "\x1b[7m", rvEnd: "\x1b[27m", reset: "\x1b[0m" };
export const COLOR_OFF: Palette = { bold: "", dim: "", red: "", green: "", code: "", rv: "", rvEnd: "", reset: "" };
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
 * TUI v5 #16e: the inline-code tint — backtick spans in ONE line of
 * assistant body text get the `code` color. Deliberately NOT a markdown
 * engine: single level only (`[^`]*` cannot nest), a span never matches
 * across lines (the caller passes one line; an opener without a closer
 * on the same line stays plain). NO_COLOR / pipes → the codes are empty
 * strings → the line passes through byte-identical.
 */
export function colorInlineCode(line: string): string {
	const p = palette();
	if (p.code === "" || p.reset === "") return line;
	return line.replace(/`([^`]*)`/g, `${p.code}\`$1\`${p.reset}`);
}

/** The canonical-path resolver for the approval detail — injected by the
 *  caller (the CLI passes the tools' own resolution). The tui package is
 *  pure terminal: input is data, output is bytes, zero runtime deps. */
export type PathResolver = (path: string) => string;

export interface RenderResult {
	readonly text: string;
	readonly newline: boolean;
	readonly prompt: boolean;
}

/**
 * the ergonomics batch C5 — the render input, the tui's OWN data shape: the subset of
 * an event stream the renderer reads, keyed by type. The CLI translates
 * its Event stream into this (Event → RenderInput) before rendering —
 * the tui package never imports kiso-core. Field names mirror the
 * rendered Event members so the render body stays byte-identical.
 */
export type RenderInput =
	| { readonly type: "user_input"; readonly content: string | readonly { readonly type?: string; readonly text?: string }[] }
	| { readonly type: "text_delta"; readonly text: string }
	| { readonly type: "text_end" }
	| { readonly type: "thinking"; readonly text: string }
	| { readonly type: "tool_call_end"; readonly name: string; readonly input: Readonly<Record<string, unknown>> | null }
	| { readonly type: "tool_execution_started" }
	| { readonly type: "tool_execution_succeeded" }
	| { readonly type: "tool_execution_failed"; readonly error: string }
	| { readonly type: "tool_result"; readonly content: string | readonly { readonly type?: string; readonly text?: string }[]; readonly isError: boolean }
	| { readonly type: "permission_requested"; readonly name: string; readonly input: Readonly<Record<string, unknown>> }
	| { readonly type: "permission_decided"; readonly decision: "approved" | "denied"; readonly reason?: string }
	| {
			readonly type: "terminal";
			readonly outcome:
				| { readonly kind: "completed" }
				| { readonly kind: "max_tokens" }
				| { readonly kind: "max_turns"; readonly turns: number }
				| { readonly kind: "error"; readonly error: { readonly message: string } }
				| { readonly kind: "aborted"; readonly by: string }
				| { readonly kind: "hook_stopped"; readonly hook: string };
		}
	| { readonly type: "compacted"; readonly cleared: readonly { readonly eventSeq?: number; readonly callId: string }[] }
	| { readonly type: "summarized"; readonly coversToSeq: number }
	| { readonly type: "uncertain_pending"; readonly name: string; readonly executionId: string; readonly error: string }
	| {
			// ⑥ task round: the durable checklist — the CLI translates a
			// do-not-compact-tagged tool result into this shape; the tui
			// renders the brick glyphs (□ pending / ▖ active / ▣ done).
			readonly type: "checklist";
			readonly header: string;
			readonly items: readonly { readonly text: string; readonly status: "pending" | "active" | "done" }[];
	  };

/**
 * Render one event. `text` may be a continuation (text_delta appends to the
 * current line); `newline` says whether the line is complete.
 *
 * bootstrap P1: `prevThinking` marks a thinking delta that continues the SAME
 * block — it renders appended to the segment, without the … prefix. The
 * consumer closes the segment with a newline at the next non-thinking
 * event.
 */
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

export function renderEvent(ev: RenderInput, prevThinking = false, resolvePath: PathResolver = (p) => p): RenderResult {
	const p = palette();
	switch (ev.type) {
		case "user_input":
			// v2a/v5: bold (the identity accent — the interactive prompt
			// echoes itself; this render is the REPLAY path).
			return { text: `${p.bold}you> ${escapeTerminal(typeof ev.content === "string" ? ev.content : "(content)")}${p.reset}\n`, newline: true, prompt: false };
		case "text_delta":
			return { text: escapeTerminal(ev.text), newline: false, prompt: false };
		case "text_end":
			return { text: "\n", newline: true, prompt: false };
		case "thinking":
			// bootstrap P1/v2b: the CONSUMER buffers each thinking block and folds
			// it to ONE dim line (foldThinking); this render is the generic
			// path for tests. The full block goes to /think.
			return {
				text: foldThinking(ev.text),
				newline: true,
				prompt: false,
			};
		case "tool_call_end":
			// v2a: plain — the call line is information, not decoration.
			return {
				text: `→ ${escapeTerminal(ev.name)}(${ev.input ? escapeTerminal(JSON.stringify(ev.input).slice(0, 200)) : ""})\n`,
				newline: true,
				prompt: false,
			};
		case "tool_execution_started":
			return { text: `${p.dim}  running…${p.reset}\n`, newline: true, prompt: false };
		case "tool_execution_succeeded":
			return { text: `  ok\n`, newline: true, prompt: false }; // v2a: plain — success is not an accent
		case "tool_execution_failed":
			return { text: `${p.red}  failed: ${escapeTerminal(ev.error.slice(0, 160))}${p.reset}\n`, newline: true, prompt: false };
		case "tool_result": {
			const content = typeof ev.content === "string" ? ev.content : ev.content.map((b) => (b.type === "text" ? b.text : "(image)")).join("");
			return {
				// v2b: the echo truncates at 160 chars + a /last hint — the
				// full content stays in the event stream.
				text: `${p.dim}${ev.isError ? p.red : p.dim}  [result${ev.isError ? " ✗" : ""}] ${foldResult(content)}${p.reset}\n`,
				newline: true,
				prompt: false,
			};
		}
		case "permission_requested":
			// round 8: the tool NAME is model text — escaped like everything else.
			return {
				text: `⏸ ${escapeTerminal(ev.name)} needs approval ${p.dim}${approvalDetail(ev.name, ev.input, resolvePath)}${p.reset} `,
				newline: false,
				prompt: true,
			};
		case "permission_decided":
			// v2a: verdicts are plain — neither success accents nor errors.
			return {
				text: `  ${ev.decision === "approved" ? "approved" : "denied"}${ev.reason ? `: ${escapeTerminal(ev.reason)}` : ""}\n`,
				newline: true,
				prompt: false,
			};
		case "terminal": {
			const outcome = ev.outcome;
			const label =
				outcome.kind === "completed"
					? `done` // v2a: plain — the ✓ mark is the success accent
					: outcome.kind === "aborted"
						? `aborted (${outcome.by})`
						: `${p.red}${outcome.kind}${p.reset}${"error" in outcome && "message" in outcome.error ? `: ${escapeTerminal((outcome.error as { message: string }).message.slice(0, 200))}` : ""}`;
			return { text: `\n${label}\n`, newline: true, prompt: false };
		}
		case "compacted":
			return { text: `${p.dim}  [compacted ${ev.cleared.length} results]${p.reset}\n`, newline: true, prompt: false };
		case "summarized":
			// ADR-0044: the /compact event is OFF-LOOP — it never appears in
			// a run stream; rendered for the switch's completeness only.
			return { text: `${p.dim}  [summarized up to seq ${ev.coversToSeq}]${p.reset}\n`, newline: true, prompt: false };
		case "uncertain_pending":
			return {
				text: `${p.red}⚠ ${escapeTerminal(ev.name)} failed (${ev.executionId}): ${escapeTerminal(ev.error.slice(0, 160))}${p.reset}\n`,
				newline: true,
				prompt: false,
			};
		case "checklist": {
			// ⑥: the durable checklist — the ▞ header accent (the recap's
			// brick) + one brick-glyph line per item. Static line content:
			// byte-identical in pipes and NO_COLOR.
			const lines = [`${p.bold}▞${p.reset} ${escapeTerminal(ev.header)}`];
			for (const item of ev.items) {
				const glyph = item.status === "pending" ? "□" : item.status === "active" ? "▖" : "▣";
				lines.push(`  ${glyph} ${escapeTerminal(item.text)}`);
			}
			return { text: `${lines.join("\n")}\n`, newline: true, prompt: false };
		}
		default:
			return { text: "", newline: false, prompt: false };
	}
}

/**
 * The approval prompt detail (Area 5/round 8): the human must be able to see
 * EVERYTHING they are approving. The shell command is shown in full; the
 * path is the CANONICAL one the tool will touch; write/edit show the FULL
 * content (never a truncated tail that hides a dangerous payload). The
 * decision is bound to the complete input via the decisionId.
 */
function approvalDetail(name: string, input: Record<string, unknown>, resolvePath: PathResolver): string {
	if (name === "shell") {
		return `\n  $ ${escapeTerminal(String(input.command ?? ""))}`;
	}
	if (name === "write_file") {
		const content = String(input.content ?? "");
		return `\n  ${escapeTerminal(resolvePath(String(input.path ?? "?")))}\n  ${escapeTerminal(content)}`;
	}
	if (name === "edit_file") {
		return `\n  ${escapeTerminal(resolvePath(String(input.path ?? "?")))}\n  replace: ${escapeTerminal(String(input.search ?? ""))}\n  with:    ${escapeTerminal(String(input.replace ?? ""))}`;
	}
	return `\n  ${escapeTerminal(JSON.stringify(input))}`;
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

/** B area: usage data gathered from the run's usage events. */
export interface RunUsage {
	readonly in: number | null;
	readonly out: number | null;
	readonly cache: number | null;
	readonly known: boolean;
}

/**
 * B area/v2a: the one-line status bar after a terminal, e.g.
 *   [turn 3 · in 12.4k out 1.8k · cache 9.2k · ctx ~14%]
 * Denoising: unknown fields are OMITTED ENTIRELY (show what there is); a fully unknown
 * usage → null (the caller prints nothing); faux mode → [turn N · faux].
 * All data comes from usage events; ctx is the approximate estimate
 * passed in (chars/4 vs the window), marked with ~.
 */
export function renderStatusLine(turn: number, usage: RunUsage, ctxRatio: number, faux = false): string | null {
	if (faux) return `[turn ${turn} · faux]`;
	if (!usage.known) return null; // everything unknown — nothing worth showing
	const parts: string[] = [];
	if (usage.in !== null || usage.out !== null) {
		const seg = `${usage.in !== null ? `in ${kUnit(usage.in)}` : ""}${usage.in !== null && usage.out !== null ? " " : ""}${usage.out !== null ? `out ${kUnit(usage.out)}` : ""}`;
		parts.push(seg);
	}
	if (usage.cache !== null) parts.push(`cache ${kUnit(usage.cache)}`);
	if (Number.isFinite(ctxRatio)) parts.push(`ctx ~${Math.round(ctxRatio * 100)}%`);
	if (parts.length === 0) return null;
	return `[turn ${turn} · ${parts.join(" · ")}]`;
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

/** v3 §02 — the recap line that ends a run, replacing the "done" label +
 *  the old status line. All fields derive LOCALLY from the event stream
 *  (zero tokens): wall seconds, tool counts, usage, cache hit %, ctx left.
 */
export interface RecapStats {
	readonly seconds: number;
	readonly tools: number;
	readonly edits: number;
	readonly usage: RunUsage;
	/** R-C item 4: the per-turn cache miss (min(prevIn, in) − cacheRead),
	 *  passed only when above the noise floor — the re-sent-uncached
	 *  prefix. Absent → the recap bytes stay the historical form. */
	readonly missed?: number;
	readonly ctxLeftPct: number | null; // 0..100, null when unknowable
	/** W19 — the mode the turn ran under. Under "plan" the recap becomes
	 *  the way-forward row (the claimed shape): a plan turn's currency is
	 *  the plan, not the tool count — the timing and tool-count parts
	 *  drop, and the two /mode hints replace them. */
	readonly mode?: string;
}

export function renderRecap(s: RecapStats): string {
	const p = palette();
	// W19: under plan the recap is the way out of the mode — the header
	// names the mode's posture, the hints name the exits (the ONLY
	// controls — /mode is the only way to leave plan mode).
	if (s.mode === "plan") {
		const parts = ["plan ready", "/mode default executes", "/mode accept-edits auto-approves edits"];
		if (s.ctxLeftPct !== null) parts.push(`ctx left ~${Math.round(s.ctxLeftPct)}%`);
		return `${p.bold}▞${p.reset} ${parts.join(" · ")}\n`;
	}
	const parts = [`${s.seconds}s`, `${s.tools} tool${s.tools === 1 ? "" : "s"}${s.edits > 0 ? ` (${s.edits} edit${s.edits === 1 ? "" : "s"})` : ""}`];
	if (s.usage.known) {
		const seg = `${s.usage.in !== null ? `in ${kUnit(s.usage.in)}` : ""}${s.usage.in !== null && s.usage.out !== null ? " " : ""}${s.usage.out !== null ? `out ${kUnit(s.usage.out)}` : ""}`;
		if (seg !== "") parts.push(seg);
		if (s.usage.cache !== null && s.usage.in !== null && s.usage.in > 0) {
			const hit = `cache ${Math.round((s.usage.cache / s.usage.in) * 100)}%`;
			parts.push(s.missed !== undefined && s.missed > 0 ? `${hit} · miss ${kUnit(s.missed)}` : hit);
		}
	}
	if (s.ctxLeftPct !== null) parts.push(`ctx left ~${Math.round(s.ctxLeftPct)}%`);
	return `${p.bold}▞${p.reset} ${parts.join(" · ")}\n`;
}

/** One-line summary of a session, for `kiso sessions`. */
export function renderSessionLine(meta: { id: string; title: string; events: number; runs: number; updatedAt: number }): string {
	const when = meta.updatedAt ? new Date(meta.updatedAt).toISOString().slice(0, 16) : "—";
	// round 8: the title is the user's first prompt — model/user text, escaped.
	return `${meta.id.padEnd(24)} ${meta.runs} runs ${String(meta.events).padStart(5)} events  ${when}  ${escapeTerminal(meta.title)}`;
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
	const titleW = Math.max(1, W - 13 - metaW);
	for (let i = 0; i < metas.length; i += 1) {
		const title = escapeTerminal(metas[i]!.title);
		const shown = titleCut(title, titleW);
		const pad = titleW - displayWidth(shown);
		rows.push(`    ${whens[i]!.padEnd(7)} ${shown}${" ".repeat(pad)} ${metaTexts[i]!.padStart(metaW)}`);
	}
	return rows;
}
