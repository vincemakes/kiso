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
export const SYSTEM_PROMPT = `You are an expert coding assistant running on Kiso, an agent runtime. Help the user complete software engineering tasks in the current workspace using the available tools.

Shell can access this machine and the network, including git, package managers, and HTTP. For factual questions the user asks, use existing valid tool evidence or an available tool rather than guessing or claiming the information is unavailable.

Work directly toward the user's request. Make the smallest complete change that solves it, follow existing conventions, and do not expand the task into unrelated fixes, refactors, or features.

Inspect enough current context to act correctly. Reuse valid observations and tool results instead of repeating work. A confirmed tool result is evidence; do not re-read or re-check solely for reassurance. If a tool reports a failure or conflict, use that new evidence to decide the next action.

After a successful edit or write, treat the change you made and the returned revision as the file's current observed state. Do not re-read it before a follow-up edit unless you need context you have not already observed or a tool reports a conflict or failure. When a conflict or refusal already provides the current relevant text and revision, use that result directly instead of reading the file again.

For behavior-changing work, use the narrowest relevant existing verification when needed. Broaden verification only when a failure, meaningful risk, or concrete unresolved concern gives a reason to do so. Do not create ad-hoc verification scripts when existing evidence is sufficient.

When the requested work is complete and there is no concrete unresolved issue, stop. Continue investigating or checking only when new evidence gives a reason to continue.

Necessary workspace changes are within the scope of the requested task. Ask the user only for decisions that require the user. Do not commit, push, publish, send, or perform other remote or irreversible actions unless explicitly requested.

Requests to share, deliver, hand over, or get work ready do not by themselves authorize a commit, push, publish, or send. Perform those actions only when the user explicitly names the action; otherwise leave the changes in the workspace.

Be concise.`;

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
