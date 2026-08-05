/**
 * Event rendering for the terminal. Pure (testable): given events, produce
 * the lines a human sees. Colors are raw ANSI — no dependencies.
 */

import type { Event } from "@vincemakes/kiso-core";
import { canonicalTargetPath } from "@vincemakes/kiso-tools-node";

/**
 * v2a — the palette, centralized (no hard-coded codes elsewhere): ONE
 * accent — blue, ANSI 256 color 75 — for the identity accents (the you>
 * prompt, the banner tagline, ✓ marks, slash-command names); red for
 * errors; dim for metadata. NO_COLOR set, or a non-TTY output → every
 * code is empty, so pipes and CI carry ZERO ANSI (the existing byte-level
 * e2e assertions guard it). Everything not listed here is plain.
 * v3: `bg` — the user-message block background (SGR 48, dark gray 237).
 */
export interface Palette {
	readonly blue: string;
	readonly dim: string;
	readonly red: string;
	readonly green: string; // v2e: the diff additions — diff-only (NO_COLOR falls back to the + prefix)
	readonly bg: string; // v3: the user-message block background
	readonly reset: string;
}
export const COLOR_ON: Palette = { blue: "\x1b[38;5;75m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", bg: "\x1b[48;5;237m", reset: "\x1b[0m" };
export const COLOR_OFF: Palette = { blue: "", dim: "", red: "", green: "", bg: "", reset: "" };
export function palette(): Palette {
	return process.env.NO_COLOR === undefined && process.stdout.isTTY ? COLOR_ON : COLOR_OFF;
}

/**
 * E 组/八: strip terminal-injection vectors from MODEL/TOOL text before it
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
 * 八/十: the path the human is asked to approve is the CANONICAL one the
 * tool will actually touch — the tools' OWN resolution (deepest existing
 * ancestor realpath'd, the not-yet-existing tail re-appended), so a file
 * to be created under a symlinked directory shows the REAL target, and
 * the UI and the tool share ONE resolution (canonicalTargetPath).
 */
export const canonicalPath = canonicalTargetPath;

export interface RenderResult {
	readonly text: string;
	readonly newline: boolean;
	readonly prompt: boolean;
}

/**
 * Render one event. `text` may be a continuation (text_delta appends to the
 * current line); `newline` says whether the line is complete.
 *
 * 自举 P1: `prevThinking` marks a thinking delta that continues the SAME
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

export function renderEvent(ev: Event, prevThinking = false): RenderResult {
	const p = palette();
	switch (ev.type) {
		case "user_input":
			// v2a: blue (the identity accent — the interactive prompt echoes
			// itself; this render is the REPLAY path).
			return { text: `${p.blue}you> ${escapeTerminal(typeof ev.content === "string" ? ev.content : "(content)")}${p.reset}\n`, newline: true, prompt: false };
		case "text_delta":
			return { text: escapeTerminal(ev.text), newline: false, prompt: false };
		case "text_end":
			return { text: "\n", newline: true, prompt: false };
		case "thinking":
			// 自举 P1/v2b: the CONSUMER buffers each thinking block and folds
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
			// 八: the tool NAME is model text — escaped like everything else.
			return {
				text: `⏸ ${escapeTerminal(ev.name)} needs approval ${p.dim}${approvalDetail(ev.name, ev.input)}${p.reset} `,
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
		case "uncertain_pending":
			return {
				text: `${p.red}⚠ ${escapeTerminal(ev.name)} failed (${ev.executionId}): ${escapeTerminal(ev.error.slice(0, 160))}${p.reset}\n`,
				newline: true,
				prompt: false,
			};
		default:
			return { text: "", newline: false, prompt: false };
	}
}

/**
 * The approval prompt detail (Area 5/八): the human must be able to see
 * EVERYTHING they are approving. The shell command is shown in full; the
 * path is the CANONICAL one the tool will touch; write/edit show the FULL
 * content (never a truncated tail that hides a dangerous payload). The
 * decision is bound to the complete input via the decisionId.
 */
function approvalDetail(name: string, input: Record<string, unknown>): string {
	if (name === "shell") {
		return `\n  $ ${escapeTerminal(String(input.command ?? ""))}`;
	}
	if (name === "write_file") {
		const content = String(input.content ?? "");
		return `\n  ${escapeTerminal(canonicalPath(String(input.path ?? "?")))}\n  ${escapeTerminal(content)}`;
	}
	if (name === "edit_file") {
		return `\n  ${escapeTerminal(canonicalPath(String(input.path ?? "?")))}\n  replace: ${escapeTerminal(String(input.search ?? ""))}\n  with:    ${escapeTerminal(String(input.replace ?? ""))}`;
	}
	return `\n  ${escapeTerminal(JSON.stringify(input))}`;
}

/**
 * B 区: one-line summary of a completed tool call, e.g.
 *   ✓ edit src/foo.ts (+12 -3)    ✓ read src/bar.ts (140 lines)
 *   ✗ shell npm test (exit 1)
 * edit/write show +/- line counts, read shows lines, shell shows the exit
 * code; failures (isError) are ✗. Pure and deterministic.
 */
export function renderToolSummary(
	name: string,
	input: Record<string, unknown>,
	result: { content: string; isError: boolean },
): string {
	// v2a: ✓ is a blue identity accent; ✗ stays red.
	const p = palette();
	const mark = result.isError ? `${p.red}✗${p.reset}` : `${p.blue}✓${p.reset}`;
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

/** B 区: usage data gathered from the run's usage events. */
export interface RunUsage {
	readonly in: number | null;
	readonly out: number | null;
	readonly cache: number | null;
	readonly known: boolean;
}

/**
 * B 区/v2a: the one-line status bar after a terminal, e.g.
 *   [turn 3 · in 12.4k out 1.8k · cache 9.2k · ctx ~14%]
 * 降噪: unknown fields are OMITTED ENTIRELY (有什么显什么); a fully unknown
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
 * hugs the terminal (有什么显什么 — omitted when there is nothing to show),
 * then EXACTLY one blank line before the next prompt. The consumer prints
 * this verbatim; the render tests pin the sequence.
 */
export function renderTerminalGap(statusLine: string | null): string {
	return `${statusLine === null ? "" : `${statusLine}\n`}\n`;
}

/**
 * v3 §01 — the banner, block-split. The logo is three INDEPENDENT rows
 * (TOP / the tagline / BOTTOM), then TWO info rows (version,
 * extensions). Every row truncates at the terminal width with a " (+N)"
 * marker (N = the hidden display width); a window narrower than 40
 * columns skips the logo entirely — only the info rows. Pure.
 */
export const TAGLINE = "the coding agent that survives kill -9";
const LOGO_ROWS = ["█ █ ▀█▀ █▀▀ █▀█", TAGLINE, "▀ ▀ ▀▀▀ ▀▀▀ ▀▀▀"] as const;

/** Display width of a row (1-cell ASCII; 2-cell CJK/wide). */
function displayW(row: string): number {
	let w = 0;
	for (let i = 0; i < row.length; i += 1) {
		const cp = row.codePointAt(i)!;
		w += cp > 0xff ? 2 : 1;
	}
	return w;
}

/** v3 §01: truncate a row at `width`, marking the hidden span " (+N)". */
export function truncateRow(row: string, width: number): string {
	if (displayW(row) <= width) return row;
	const cut = Math.max(0, width - 4);
	let w = 0;
	let i = 0;
	for (; i < row.length; i += 1) {
		const cw = row.codePointAt(i)! > 0xff ? 2 : 1;
		if (w + cw > cut) break;
		w += cw;
	}
	return `${row.slice(0, i)} (+${displayW(row) - w})`;
}

/** v3 §01: the banner lines for a width W — logo (skipped under 40
 *  columns) + version + extensions. */
export function bannerLines(W: number, version: string, extensionsText: string): string[] {
	const rows: string[] = [];
	if (W >= 40) for (const r of LOGO_ROWS) rows.push(truncateRow(r, W));
	rows.push(truncateRow(`v${version}`, W));
	if (extensionsText !== "") rows.push(truncateRow(extensionsText, W));
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
	readonly ctxLeftPct: number | null; // 0..100, null when unknowable
}

export function renderRecap(s: RecapStats): string {
	const p = palette();
	const parts = [`${s.seconds}s`, `${s.tools} tool${s.tools === 1 ? "" : "s"}${s.edits > 0 ? ` (${s.edits} edit${s.edits === 1 ? "" : "s"})` : ""}`];
	if (s.usage.known) {
		const seg = `${s.usage.in !== null ? `in ${kUnit(s.usage.in)}` : ""}${s.usage.in !== null && s.usage.out !== null ? " " : ""}${s.usage.out !== null ? `out ${kUnit(s.usage.out)}` : ""}`;
		if (seg !== "") parts.push(seg);
		if (s.usage.cache !== null && s.usage.in !== null && s.usage.in > 0) {
			parts.push(`cache ${Math.round((s.usage.cache / s.usage.in) * 100)}%`);
		}
	}
	if (s.ctxLeftPct !== null) parts.push(`ctx left ~${Math.round(s.ctxLeftPct)}%`);
	return `${p.blue}▞${p.reset} ${parts.join(" · ")}\n`;
}

/** One-line summary of a session, for `kiso sessions`. */
export function renderSessionLine(meta: { id: string; title: string; events: number; runs: number; updatedAt: number }): string {
	const when = meta.updatedAt ? new Date(meta.updatedAt).toISOString().slice(0, 16) : "—";
	// 八: the title is the user's first prompt — model/user text, escaped.
	return `${meta.id.padEnd(24)} ${meta.runs} runs ${String(meta.events).padStart(5)} events  ${when}  ${escapeTerminal(meta.title)}`;
}
