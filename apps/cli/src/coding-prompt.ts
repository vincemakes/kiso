/**
 * The coding product's prompt policy — the base system prompt and the
 * project-instruction injection. Moved verbatim from index.ts (R1,
 * 2026-09-23): the entry module keeps no prompt text of its own.
 */

import { protectedFiles } from "./state.js";
import { isProtectedPath, protectedIdentity } from "@vincemakes/kiso-tools-node";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/**
 * A area: the coding-agent system prompt — ONE constant, byte-stable for the
 * session's lifetime (D area). Kept under ~80 lines; no template engine.
 */
/** The built-in prompt. Exported for scripts/request-surface.mjs — the
 *  model-side token-rent counter measures the REAL bytes, never a copy. */
export const SYSTEM_PROMPT = `You are kiso, a coding agent. You work in a workspace
directory and change code with tools. Be concise: answer in a few lines
unless the task genuinely needs more. Never claim a file was changed
unless a tool confirmed it.

What you can reach:
- The workspace: read_file, list_dir, search_text, write_file, edit_file.
- This machine and the network: shell — builds, tests, git, package
  managers, curl for HTTP, system queries. A request one command can
  answer is answered by running it.
- The human: ask_user, for a decision that is theirs.

Tool discipline:
- READ BEFORE YOU EDIT. For any file you are about to change, read it
  first — never guess its content.
- Use edit_file for targeted changes and write_file for new files or
  full rewrites.
- Be careful — shell has side effects and may take time.
- search_text and list_dir are cheap — locate first, then read ranges
  with read_file offset/limit; never read a whole large file in one call.
- Do not re-read a file you already read unchanged, or one you changed
  yourself through a confirmed edit — rely on the earlier result and
  on the change you just made.
- When a tool fails, read the error and adjust; do not repeat the same
  call blindly.

An authorization covers what it NAMES: when the scope is not named —
which files, which branches, whether to push — ask before acting.
Delivering, sharing or handing over changes means committing locally and
stopping; pushing, publishing or sending happens only when the human
names it.

Workflow: understand the request, find the relevant code, make the
smallest change that works, then verify with a command (tests/build).
Report what you did in one or two lines per change.`;

/** The project-instructions file names, in priority order (A area). */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
/** Hard cap for injected instructions — truncate and say so. */

/**
 * A area: read the FIRST present instruction file (AGENTS.md preferred) and
 * return it as an injected section, or "" when none exists. Truncated at
 * 8KB with an explicit note. Pure — read once per session, so the prompt
 * is byte-stable for the session's lifetime.
 *
 * kiso never serves its own credential store to a model, and this read is
 * the one that needs no model at all: a cloned repository whose AGENTS.md
 * is a symlink to the store would put it in the SYSTEM PROMPT of every
 * request, with no tool call and no trust prompt. A file that resolves to
 * a protected one is skipped as though absent.
 */
export function readProjectInstructions(cwd: string, protectedFiles: readonly string[] = []): string {
	const found = projectInstructions(cwd, protectedFiles);
	if (found === null) return "";
	const { name, text } = found;
	return `\n\n=== Project instructions (${name}) ===\n${text.length > 8 * 1024 ? text.slice(0, 8 * 1024) + `\n\n[truncated at ${8 * 1024} chars]` : text}`;
}

/** The instruction file the prompt reads, and its text — the ONE lookup,
 *  so the opening's RULES fact (Graphite §7.10) names exactly the file the
 *  model is given, never a file it is not. */
export function projectInstructions(cwd: string, protectedFiles: readonly string[] = []): { readonly name: string; readonly text: string } | null {
	const id = protectedIdentity(protectedFiles);
	for (const name of INSTRUCTION_FILES) {
		if (isProtectedPath(join(cwd, name), id)) continue;
		try {
			return { name, text: readFileSync(join(cwd, name), "utf8") };
		} catch {
			continue; // not present — try the next
		}
	}
	return null;
}

/** A area: the session's system prompt — the constant plus any project
 *  instructions found in the workspace. Deterministic per cwd. */
export function composeSystemPrompt(cwd: string, protectedFiles: readonly string[] = []): string {
	const injected = readProjectInstructions(cwd, protectedFiles);
	return injected === "" ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}\n${injected}`;
}

/**
 * The coding agent's tool-table vocabulary — one routing line per tool, in
 * the table only while that tool is active (0.1.40, R-C item 1: the
 * reference implementation's content in kiso's voice). ACI-6 made this the
 * ONE canonical statement of the routing policy; the base prompt above no
 * longer restates it.
 *
 * R1 (2026-09-23): moved verbatim from the runtime's compose.ts, where it
 * sat as a constant and reached every host whose tools shared these names.
 * The rows, their order and their position in the table are unchanged —
 * the byte fixture in tests/fixtures pins that.
 */
export const CODING_TOOL_RULES: ReadonlyArray<{ readonly tool: string; readonly line: string }> = [
	{ tool: "read_file", line: "read files with read_file, never shell cat/head/tail" },
	{ tool: "search_text", line: "search with search_text, never shell grep/rg" },
	{ tool: "list_dir", line: "list with list_dir, never ls" },
	{ tool: "shell", line: "shell for what the file tools cannot do: commands, git, the network, the system" },
];
