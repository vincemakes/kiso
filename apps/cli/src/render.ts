/**
 * Event rendering for the terminal. Pure (testable): given events, produce
 * the lines a human sees. Colors are raw ANSI — no dependencies.
 */

import type { Event } from "@vincemakes/kiso-core";
import { canonicalTargetPath } from "@vincemakes/kiso-tools-node";

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

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
export function renderEvent(ev: Event, prevThinking = false): RenderResult {
	switch (ev.type) {
		case "user_input":
			return { text: `${YELLOW}you> ${escapeTerminal(typeof ev.content === "string" ? ev.content : "(content)")}${RESET}\n`, newline: true, prompt: false };
		case "text_delta":
			return { text: escapeTerminal(ev.text), newline: false, prompt: false };
		case "text_end":
			return { text: "\n", newline: true, prompt: false };
		case "thinking":
			// 自举 P1: ONE thinking block streams as ONE segment — deltas
			// append inline; the … prefix marks the block start only.
			return {
				text: `${DIM}${prevThinking ? "" : "…"}${escapeTerminal(ev.text.slice(0, 200))}${RESET}`,
				newline: false,
				prompt: false,
			};
		case "tool_call_end":
			return {
				text: `${CYAN}→ ${escapeTerminal(ev.name)}(${ev.input ? escapeTerminal(JSON.stringify(ev.input).slice(0, 200)) : ""})${RESET}\n`,
				newline: true,
				prompt: false,
			};
		case "tool_execution_started":
			return { text: `${DIM}  running…${RESET}\n`, newline: true, prompt: false };
		case "tool_execution_succeeded":
			return { text: `${GREEN}  ok${RESET}\n`, newline: true, prompt: false };
		case "tool_execution_failed":
			return { text: `${RED}  failed: ${escapeTerminal(ev.error.slice(0, 160))}${RESET}\n`, newline: true, prompt: false };
		case "tool_result": {
			const content = typeof ev.content === "string" ? ev.content : ev.content.map((b) => (b.type === "text" ? b.text : "(image)")).join("");
			return {
				text: `${DIM}${ev.isError ? RED : DIM}  [result${ev.isError ? " ✗" : ""}] ${escapeTerminal(content.slice(0, 400).replaceAll("\n", " "))}${RESET}\n`,
				newline: true,
				prompt: false,
			};
		}
		case "permission_requested":
			// 八: the tool NAME is model text — escaped like everything else.
			return {
				text: `${YELLOW}⏸ ${escapeTerminal(ev.name)} needs approval${RESET} ${DIM}${approvalDetail(ev.name, ev.input)}${RESET} `,
				newline: false,
				prompt: true,
			};
		case "permission_decided":
			return {
				text: `${ev.decision === "approved" ? GREEN : RED}  ${ev.decision === "approved" ? "approved" : "denied"}${ev.reason ? `: ${escapeTerminal(ev.reason)}` : ""}${RESET}\n`,
				newline: true,
				prompt: false,
			};
		case "terminal": {
			const outcome = ev.outcome;
			const label =
				outcome.kind === "completed"
					? `${GREEN}done${RESET}`
					: outcome.kind === "aborted"
						? `${YELLOW}aborted (${outcome.by})${RESET}`
						: `${RED}${outcome.kind}${RESET}${"error" in outcome && "message" in outcome.error ? `: ${escapeTerminal((outcome.error as { message: string }).message.slice(0, 200))}` : ""}`;
			return { text: `\n${label}\n`, newline: true, prompt: false };
		}
		case "compacted":
			return { text: `${DIM}  [compacted ${ev.cleared.length} results]${RESET}\n`, newline: true, prompt: false };
		case "uncertain_pending":
			return {
				text: `${RED}⚠ ${escapeTerminal(ev.name)} failed (${ev.executionId}): ${escapeTerminal(ev.error.slice(0, 160))}${RESET}\n`,
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
	const mark = result.isError ? "✗" : "✓";
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
function kUnit(value: number | null): string {
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
 * B 区: the one-line status bar after a terminal, e.g.
 *   [turn 3 · in 12.4k out 1.8k · cache 9.2k · ctx ~14%]
 * All data comes from usage events (known:false renders ?); ctx is the
 * approximate estimate passed in (chars/4 vs the window), marked with ~.
 */
export function renderStatusLine(turn: number, usage: RunUsage, ctxRatio: number): string {
	const ctx = Number.isFinite(ctxRatio) ? `~${Math.round(ctxRatio * 100)}%` : "~?";
	return `[turn ${turn} · in ${kUnit(usage.in)} out ${kUnit(usage.out)} · cache ${kUnit(usage.cache)} · ctx ${ctx}]`;
}

/** One-line summary of a session, for `kiso sessions`. */
export function renderSessionLine(meta: { id: string; title: string; events: number; runs: number; updatedAt: number }): string {
	const when = meta.updatedAt ? new Date(meta.updatedAt).toISOString().slice(0, 16) : "—";
	// 八: the title is the user's first prompt — model/user text, escaped.
	return `${meta.id.padEnd(24)} ${meta.runs} runs ${String(meta.events).padStart(5)} events  ${when}  ${escapeTerminal(meta.title)}`;
}
