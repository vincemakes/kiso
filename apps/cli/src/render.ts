/**
 * Event rendering for the terminal. Pure (testable): given events, produce
 * the lines a human sees. Colors are raw ANSI — no dependencies.
 */

import type { Event } from "@kiso/core";

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

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
			return { text: `${YELLOW}you> ${typeof ev.content === "string" ? ev.content : "(content)"}${RESET}\n`, newline: true, prompt: false };
		case "text_delta":
			return { text: ev.text, newline: false, prompt: false };
		case "text_end":
			return { text: "\n", newline: true, prompt: false };
		case "thinking":
			return { text: `${DIM}…${ev.text.slice(0, 200)}${RESET}\n`, newline: true, prompt: false };
		case "tool_call_end":
			return {
				text: `${CYAN}→ ${ev.name}(${ev.input ? JSON.stringify(ev.input).slice(0, 200) : ""})${RESET}\n`,
				newline: true,
				prompt: false,
			};
		case "tool_execution_started":
			return { text: `${DIM}  running…${RESET}\n`, newline: true, prompt: false };
		case "tool_execution_succeeded":
			return { text: `${GREEN}  ok${RESET}\n`, newline: true, prompt: false };
		case "tool_execution_failed":
			return { text: `${RED}  failed: ${ev.error.slice(0, 160)}${RESET}\n`, newline: true, prompt: false };
		case "tool_result":
			return {
				text: `${DIM}${ev.isError ? RED : DIM}  [result${ev.isError ? " ✗" : ""}] ${ev.content.slice(0, 400).replaceAll("\n", " ")}${RESET}\n`,
				newline: true,
				prompt: false,
			};
		case "permission_requested":
			return {
				text: `${YELLOW}⏸ ${ev.name} needs approval${RESET} ${DIM}${approvalDetail(ev.name, ev.input)}${RESET} `,
				newline: false,
				prompt: true,
			};
		case "permission_decided":
			return {
				text: `${ev.decision === "approved" ? GREEN : RED}  ${ev.decision === "approved" ? "approved" : "denied"}${ev.reason ? `: ${ev.reason}` : ""}${RESET}\n`,
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
						: `${RED}${outcome.kind}${RESET}${"error" in outcome && "message" in outcome.error ? `: ${(outcome.error as { message: string }).message.slice(0, 200)}` : ""}`;
			return { text: `\n${label}\n`, newline: true, prompt: false };
		}
		case "compacted":
			return { text: `${DIM}  [compacted ${ev.cleared.length} results]${RESET}\n`, newline: true, prompt: false };
		default:
			return { text: "", newline: false, prompt: false };
	}
}

/**
 * The approval prompt detail (Area 5): security-critical parameters are
 * NEVER truncated. The shell command is shown in full; write/edit show the
 * full path with a content summary; the decision is bound to the complete
 * input via the decisionId, whatever the display.
 */
function approvalDetail(name: string, input: Record<string, unknown>): string {
	if (name === "shell") {
		return `\n  $ ${String(input.command ?? "")}`;
	}
	if (name === "write_file") {
		const content = String(input.content ?? "");
		return `\n  ${String(input.path ?? "?")} (${content.length} chars)\n  ${content.slice(0, 200)}${content.length > 200 ? "…" : ""}`;
	}
	if (name === "edit_file") {
		return `\n  ${String(input.path ?? "?")}\n  replace: ${String(input.search ?? "")}\n  with:    ${String(input.replace ?? "")}`;
	}
	return `\n  ${JSON.stringify(input)}`;
}

/** One-line summary of a session, for `kiso sessions`. */
export function renderSessionLine(meta: { id: string; title: string; events: number; runs: number; updatedAt: number }): string {
	const when = meta.updatedAt ? new Date(meta.updatedAt).toISOString().slice(0, 16) : "—";
	return `${meta.id.padEnd(24)} ${meta.runs} runs ${String(meta.events).padStart(5)} events  ${when}  ${meta.title}`;
}
