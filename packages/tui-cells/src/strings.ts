/**
 * tui-cells — the human-facing STRINGS (KC3 slice 1, the ADR-0041
 * escape hatch: extraction, never a raise): the readline prompt, the
 * project-trust listing rows and its panel view, the uncertain
 * execution's panel view, and the non-TTY not-trusted note. All five
 * were built inline in the CLI's trust-ui.ts before the move.
 *
 * The split is the one the ADR names. The FLOW stays in the CLI: who is
 * asked, when the ask happens, whether a TTY exists, and what a verdict
 * MEANS (granted loads, refused is sticky, a cancel records nothing) is
 * trust-ui.ts's and is untouched by this move. What the human READS is
 * presentation, and presentation belongs to the terminal layer — the
 * same reasoning that moved the status rows here in KC2 §5.
 *
 * Pure by construction: every function is (data) → bytes. No node
 * builtins, no I/O, no clock — the package's zero-dependency promise is
 * why the caller passes paths and counts in rather than having them
 * looked up here.
 */

import type { PanelView } from "./approval-panel.js";
import { escapeTerminal, palette } from "./render.js";

/** v2a: the interactive prompt — the identity accent. readline owns the
 *  echo of what the user types; we own the prompt's color. (v2c: the
 *  readline prompt keeps "you> " — the brick ▌ is the dock's row only;
 *  pipe bytes must not change.) */
export function interactivePrompt(): string {
	const p = palette();
	return `${p.bold}you> ${p.reset}`;
}

/** E3 (ADR-0037) — one discovered project artifact: the relative path
 *  and its content digest. Structural on purpose — the runtime's
 *  ProjectArtifacts satisfies it without this package importing the
 *  runtime (it imports nothing). */
export interface TrustArtifact {
	readonly path: string;
	readonly digest: string;
}

/**
 * E3 — the artifact listing: `<path>  (<digest6>)`, one row per file.
 *
 * The two callers differ by exactly the INDENT and nothing else: the
 * scrollback record indents two (its rows sit under the root's own
 * line), the panel's args do not (the block's frame supplies the
 * inset). Before the move the two rows were written out separately, two
 * template literals that had to agree by hand; the parameter keeps the
 * one real difference visible while making the rest provably identical.
 */
export function projectTrustRows(files: readonly TrustArtifact[], indent = ""): string[] {
	return files.map((f) => `${indent}${f.path}  (${f.digest.slice(0, 6)})`);
}

/** E3 — the trust gate's panel: the SIMPLE flavor (1 Yes / 3 No — no
 *  "don't ask again" rule exists for a project), the root as the title,
 *  the artifact listing as the always-verbose args, and the question as
 *  the rule override. The same rows the scrollback records — the panel
 *  is a bounded block, the record is not. */
export function projectTrustView(root: string, files: readonly TrustArtifact[]): PanelView {
	return {
		flavor: "simple",
		name: "project trust",
		title: root,
		speaker: "kiso",
		statusText: "▸ project trust",
		args: { kind: "text", lines: projectTrustRows(files) },
		ruleOverride: "trust this project's .kiso?",
		fallbackQuestion: `trust this project's .kiso? (y/n) `,
	};
}

/** E3 — the non-TTY note: artifacts were found and deliberately NOT
 *  loaded, with the one path back (run once interactively). Printed to
 *  stderr by the caller; never silent. */
export function projectUntrustedNote(count: number, root: string): string {
	return `[project .kiso] found ${count} artifact(s) in ${root} — not trusted, not loaded (run kiso interactively once to decide)`;
}

/** rounds 8/10 — the uncertain execution's panel: the SIMPLE flavor
 *  again, with the options re-labelled in the rule line (1 rerun · 3
 *  abandon). The tool name is escaped for the dock-less fallback
 *  question because it reaches the terminal as raw text there; the
 *  panel's own rows are escaped by the panel renderer. */
export function uncertainView(name: string, executionId: string): PanelView {
	return {
		flavor: "simple",
		name: "uncertain execution",
		title: `${name} (${executionId})`,
		speaker: "kiso",
		statusText: "▸ uncertain execution",
		args: { kind: "text", lines: [executionId] },
		ruleOverride: "did the interrupted execution apply? — 1 rerun · 3 abandon",
		fallbackQuestion: `⚠ interrupted execution: ${escapeTerminal(name)} (${executionId}) — did it apply? (y)es / (n)o `,
	};
}
