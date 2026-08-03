/**
 * Event rendering for the terminal. Pure (testable): given events, produce
 * the lines a human sees. Colors are raw ANSI — no dependencies.
 */

import type { Event } from "@kiso/core";
import { canonicalTargetPath } from "@kiso/tools-node";

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
 */
export function renderEvent(ev: Event): RenderResult {
	switch (ev.type) {
		case "user_input":
			return { text: `${YELLOW}you> ${escapeTerminal(typeof ev.content === "string" ? ev.content : "(content)")}${RESET}\n`, newline: true, prompt: false };
		case "text_delta":
			return { text: escapeTerminal(ev.text), newline: false, prompt: false };
		case "text_end":
			return { text: "\n", newline: true, prompt: false };
		case "thinking":
			return { text: `${DIM}…${escapeTerminal(ev.text.slice(0, 200))}${RESET}\n`, newline: true, prompt: false };
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

/** One-line summary of a session, for `kiso sessions`. */
export function renderSessionLine(meta: { id: string; title: string; events: number; runs: number; updatedAt: number }): string {
	const when = meta.updatedAt ? new Date(meta.updatedAt).toISOString().slice(0, 16) : "—";
	// 八: the title is the user's first prompt — model/user text, escaped.
	return `${meta.id.padEnd(24)} ${meta.runs} runs ${String(meta.events).padStart(5)} events  ${when}  ${escapeTerminal(meta.title)}`;
}
