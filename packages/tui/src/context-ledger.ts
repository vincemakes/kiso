/**
 * TUI2-R1 (E) — /context's attribution rows.
 *
 * The question "where did my context go?" has had an answer since E3:
 * the trace sidecar's rent ledger records, per request, exactly what
 * each static surface costs, and the context manifest records what the
 * conversation costs. Until now that answer was only readable by
 * someone willing to parse JSONL.
 *
 * This module is the presentation half and nothing else — a pure
 * function from counts to rows, with no idea where the counts came
 * from. That matters for the purity gate: the trace surface is an
 * OBSERVATION surface (ADR-0051 §6), correctness never reads it, and
 * keeping the reader in the CLI and the renderer here means this module
 * cannot accidentally become a second correctness path.
 *
 * Every number is a count the ledger already carries. Nothing here
 * estimates, projects, or predicts.
 */

import { palette } from "./render.js";

/** The counts one request's ledger yields, already grouped by surface.
 *  Estimated tokens throughout (the rent ledger's own chars/4 convention
 *  — R6), because that is the unit the ledger records. */
export interface ContextLedger {
	/** The model's context window, as the session is configured. */
	readonly window: number;
	/** system:base + every system:ext:* append EXCEPT skills. */
	readonly systemPrompt: number;
	/** system:base alone — the detail behind the row. */
	readonly systemBase: number;
	/** how many extensions appended (the detail's count). */
	readonly appends: number;
	/** the sum of the tool:* lines. */
	readonly toolTable: number;
	readonly tools: number;
	/** system:ext:skills — broken out because it is an INDEX of content
	 *  rather than an instruction, and it grows with the workspace rather
	 *  than with the build. 0 when the extension is not loaded. */
	readonly skillsIndex: number;
	/** how many skills the index lists — 0 when the caller cannot know
	 *  (the rent ledger records surfaces, never their contents). */
	readonly skills: number;
	/** the per-request skeleton (the `envelope` rent line). */
	readonly envelope: number;
	/** the context manifest's turn segments — the conversation itself. */
	readonly messages: number;
	readonly turns: number;
}

const BAR_CELLS = 12;

/** k-units for the ledger's columns: 25700 → 25.7k, 300 → 300, 11 → 11.
 *
 *  TUI2-R1.5 ⑤ (VD-15): the floor was 100, which put `11`, `0.3k` and
 *  `25.7k` in one right-aligned column — two unit systems stacked, and
 *  the reader has to switch between them row by row to compare. The
 *  repo already had a k-formatter with a 1000 floor (render.ts's kUnit,
 *  which the status row and every settled card use); this now agrees
 *  with it, so /context speaks the same number language as the rest of
 *  the product. It still differs from kUnit in never having a null to
 *  report — every ledger figure is a measured count. */
function k(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(Math.round(n));
}

/**
 * The rows: the header, the bar, one row per surface that EXISTS, and
 * the free remainder.
 *
 * An absent surface is an absent row — the rent ledger's own R9 rule
 * ("not paid = no rent"), carried into the display: a session with no
 * skills extension should not read a "skills index 0" row, because the
 * zero would look like a measurement rather than an absence.
 *
 * The columns are fixed so the numbers line up as a column of numbers;
 * the detail text rides after them, dim, and is cut by the caller's
 * width if it must be.
 */
export function contextRows(ledger: ContextLedger): string[] {
	const p = palette();
	const used = ledger.systemPrompt + ledger.toolTable + ledger.skillsIndex + ledger.envelope + ledger.messages;
	const free = Math.max(0, ledger.window - used);
	const ratio = ledger.window > 0 ? Math.min(1, used / ledger.window) : 1;
	const filled = Math.max(0, Math.min(BAR_CELLS, Math.round(ratio * BAR_CELLS)));
	const rows = [
		`${p.bold}context — ${k(used)} / ${k(ledger.window)} tokens (${Math.round(ratio * 100)}%)${p.reset}`,
		`${p.bold}${"▰".repeat(filled)}${p.reset}${p.dim}${"▱".repeat(BAR_CELLS - filled)}${p.reset}`,
	];
	/** One surface row: the label at 14 columns, the count right-aligned
	 *  at 5, then the dim detail. */
	const row = (label: string, value: number, detail: string): string =>
		`  ${p.bold}▰${p.reset} ${label.padEnd(14)}${p.bold}${k(value).padStart(5)}${p.reset}${detail === "" ? "" : `  ${p.dim}${detail}${p.reset}`}`;
	if (ledger.systemPrompt > 0) {
		rows.push(
			row(
				"system prompt",
				ledger.systemPrompt,
				`(base ${k(ledger.systemBase)}${ledger.appends > 0 ? ` + ${ledger.appends} extension append${ledger.appends === 1 ? "" : "s"}` : ""})`,
			),
		);
	}
	if (ledger.toolTable > 0) rows.push(row("tool table", ledger.toolTable, `${ledger.tools} tool${ledger.tools === 1 ? "" : "s"}`));
	if (ledger.skillsIndex > 0) {
		// the skill COUNT is not in the ledger (rent records surfaces, not
		// their contents) — a caller that knows it passes it, and a caller
		// that does not gets the honest half of the sentence rather than a
		// fabricated number.
		rows.push(row("skills index", ledger.skillsIndex, `${ledger.skills > 0 ? `${ledger.skills} skill${ledger.skills === 1 ? "" : "s"}, ` : ""}tier-1 lines only`));
	}
	if (ledger.envelope > 0) rows.push(row("envelope", ledger.envelope, ""));
	if (ledger.messages > 0) rows.push(row("messages", ledger.messages, `${ledger.turns} turn${ledger.turns === 1 ? "" : "s"}`));
	rows.push(`  ${p.dim}▱ ${"free".padEnd(14)}${k(free).padStart(5)}${p.reset}`);
	return rows;
}

/** TUI2-R1 (E) — the honest fallback. The ledger is written PER REQUEST:
 *  a session that has not called the model yet has no sidecar, and the
 *  right thing to show is that fact and the one step that produces one.
 *  Never an empty bar — an empty bar reads as "measured zero". */
export function contextUnavailableRows(reason: string): string[] {
	const p = palette();
	return [`${p.bold}context — no ledger yet${p.reset}`, `  ${p.dim}${reason}${p.reset}`];
}
