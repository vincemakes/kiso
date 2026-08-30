/**
 * tui-cells — the human-facing STRINGS (KC3 slice 1, the escape hatch
 * of ADR-0043, which supersedes ADR-0041): the readline prompt, the
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
import { displayWidth } from "./width.js";

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
		statusText: "⏸ project trust",
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
 *  again. TUI2-R3v2 ①: the option labels used to be smuggled into the
 *  rule line ("— 1 rerun · 3 abandon") because the panel only ever
 *  rendered "Yes" and "No"; they ride `simpleOptions` now and land on the
 *  rows themselves, which is both where they belong and the only way they
 *  stay true — the digits moved, and copy naming a digit it does not own
 *  goes stale silently. The tool name is escaped for the dock-less
 *  fallback question because it reaches the terminal as raw text there;
 *  the panel's own rows are escaped by the panel renderer.
 *
 *  RD1B-F1 (the answer-inversion fix, 2026-08-24) — both questions ask
 *  the ACTION now, not the state. They used to read "did it apply?",
 *  which the dock-less path turns into an inversion: askPanel maps `y`
 *  to allow and resolveUncertains maps allow to rerun, so the TRUTHFUL
 *  answer from a human who checked the workspace ("yes, it applied")
 *  re-ran the effect that had already applied — RD-1B's C3 double-deploy,
 *  both runs. The rule line still carries the uncertainty ("may have
 *  applied"); what follows it is the action the answer performs. The
 *  invariant a test now holds for every simple view: the dock-less
 *  question names `simpleOptions[0]`, the action `y` performs. */
/**
 * TV-1B — the verification offer (the thin task driver's one question):
 * shown at a NORMAL settle when every item is claimed done and no
 * passing check is fresh. The panel's simple flavor; bare-Enter
 * approves, Esc dismisses. The fallback question serves a dock-less
 * TTY; non-interactive paths never reach askPanel at all.
 */
export function verifyOfferView(): PanelView {
	return {
		flavor: "simple",
		name: "verification",
		title: "finish the checklist?",
		speaker: "kiso",
		statusText: "\u23f8 run paused",
		args: { kind: "text", lines: [] },
		ruleOverride: "every item is marked done \u2014 run a check?",
		simpleOptions: ["run a verification pass", "not now"],
		fallbackQuestion: "run a verification pass? (y/n) ",
	};
}

export function uncertainView(name: string, executionId: string): PanelView {
	return {
		flavor: "simple",
		name: "uncertain execution",
		title: `${name} (${executionId})`,
		speaker: "kiso",
		statusText: "⏸ uncertain execution",
		args: { kind: "text", lines: [executionId] },
		ruleOverride: "an interrupted execution may have applied — rerun it?",
		simpleOptions: ["rerun it", "abandon it"],
		fallbackQuestion: `⚠ interrupted execution: ${escapeTerminal(name)} (${executionId}) — rerun it? (y)es / (n)o `,
	};
}

/**
 * KC3.5 — the SAME uncertainty gate, said honestly for an ask_user call.
 *
 * "Did the interrupted execution apply?" is the right question for a
 * side effect and the wrong one for a question: nothing applied, the
 * human simply never answered. The COPY special-cases ask_user; the
 * mechanism does not — the verdict still maps to the runtime's own
 * rerun/abandoned resolution, whose error-fill text is untouched.
 *
 * (The round's ① probe pinned why this surface exists at all: the
 * shipped recovery blocks on a started-unreported execution regardless
 * of idempotency, so an interrupted ask meets this gate on the way
 * back. Re-asking is safe — that is what the first option says out loud.)
 */
export function unansweredAskView(executionId: string): PanelView {
	return {
		flavor: "simple",
		name: "unanswered question",
		title: `ask_user (${executionId})`,
		speaker: "kiso",
		statusText: "⏸ unanswered question",
		args: { kind: "text", lines: [executionId] },
		ruleOverride: "an unanswered question was interrupted — ask it again?",
		simpleOptions: ["ask it again", "drop it"],
		fallbackQuestion: `⚠ an unanswered question was interrupted (${executionId}) — ask it again? (y)es / (n)o `,
	};
}

/** An extension as the banner names it — the live `connecting` flag is
 *  the MCP bridge's in-flight state ("mcp (connecting…)"). Structural on
 *  purpose: the runtime's KisoExtension satisfies it without this
 *  package importing the runtime. */
export interface BannerExtension {
	readonly name: string;
	readonly connecting?: boolean;
}

/**
 * KC3.5 slice ⓪ (the extraction) — the `[N extensions: …]` banner text:
 * the built-in column, then the user-level names, then the project-level
 * ones marked `project:`.
 *
 * A pure function of three name lists, so what the banner SAYS is
 * testable without a terminal — which matters this round, because the
 * count is where the ask's TTY gate becomes visible: an interactive
 * session reads `built-in: mcp, skills, subagent, ask` and a piped one
 * reads `built-in: mcp, skills, subagent`, from this one composition.
 */
export function extensionsBannerText(
	builtIn: readonly BannerExtension[],
	user: readonly BannerExtension[],
	project: readonly BannerExtension[],
): string {
	const total = builtIn.length + user.length + project.length;
	if (total === 0) return "";
	const label = (e: BannerExtension): string => (e.connecting === true ? `${e.name} (connecting…)` : e.name);
	const parts: string[] = [];
	if (builtIn.length > 0) parts.push(`built-in: ${builtIn.map(label).join(", ")}`);
	if (user.length > 0) parts.push(user.map(label).join(", "));
	if (project.length > 0) parts.push(`project: ${project.map(label).join(", ")}`);
	return ` · [${total} extension${total === 1 ? "" : "s"}: ${parts.join(" · ")}]`;
}

// ---- TUI2-R1 (D): the keys, in ONE place ----

/** One gesture: what you press, and what it does. */
export interface KeyBinding {
	readonly keys: string;
	readonly what: string;
}

/**
 * TUI2-R1 (D) — THE key table. Every reader derives from it: the `?`
 * sheet and /help's keys row. A sheet that has drifted from the keys is
 * worse than no sheet, and the only way to make drift impossible is to
 * have one table and no second copy of it.
 *
 * The order is the sheet's reading order, which is why it is grouped by
 * WHAT A HUMAN IS DOING rather than alphabetically: the three ways to
 * put something in (send, newline, files), the three ways to change
 * course (stop, redirect, commands), then the walks (history, expand),
 * then the completions.
 */
export const KEY_BINDINGS: readonly KeyBinding[] = [
	{ keys: "enter", what: "send" },
	{ keys: "ctrl+j / shift+⏎", what: "newline" },
	{ keys: "@", what: "files" },
	{ keys: "esc", what: "stop" },
	{ keys: "alt+⏎ / ctrl+⏎", what: "redirect" },
	{ keys: "/", what: "commands" },
	{ keys: "↑↓", what: "history / queue pop" },
	{ keys: "ctrl+r", what: "expand cells" },
	{ keys: "tab", what: "complete (menu / @)" },
	{ keys: "?", what: "this sheet" },
	{ keys: "ctrl+z / ctrl+y", what: "undo / redo" },
];

/**
 * TUI2-R2pre ④ — THE display-verb table (the integrator's ruling).
 *
 * The screen names the ACT; the tool table names the CALL. Two
 * audiences, two vocabularies, and only the human's one lives here: the
 * API names DO NOT change, because the model-request surface is frozen
 * rent and every byte of it is paid for on every turn. The
 * rename-the-tools path is REJECTED by ruling.
 *
 * One table, for the same reason KEY_BINDINGS above is one table. The
 * mapping used to exist three and a half times — a `.replace("_file",
 * "")` in components.ts, another in render.ts, two more in the
 * compositor, and a private three-tool table for the rollup's expanded
 * list — and the drift was visible on a single screen: a card head
 * reading `read` directly above one reading `list_dir`.
 *
 * An unmapped tool (an extension's, an MCP server's) renders its own
 * name. Inventing a verb for a tool this package has never heard of
 * would be a worse lie than printing what the model actually calls.
 */
const DISPLAY_VERB: Readonly<Record<string, string>> = {
	read_file: "read",
	list_dir: "list",
	search_text: "search",
	write_file: "write",
	edit_file: "edit",
	shell: "shell",
};

/** A tool's name as the SCREEN says it. Display-only: the raw name stays
 *  on the cell, and dispatch, the mode gate, the policy keys, the /last
 *  RAW block and every model-facing byte keep reading that. */
export function displayVerb(name: string): string {
	return DISPLAY_VERB[name] ?? name;
}

/** The panel keys, which belong to a panel rather than the composer —
 *  one dim line rather than four table rows, because they apply only
 *  while a panel is up. */
/**
 * TUI2-R1.5 pin 6 — this row has to be true of BOTH panel flavors.
 *
 * The R1.5 wording ("digits pick · ⏎ confirms") was the sentence that
 * covered an approval where a digit only SELECTED and an ask where a
 * digit ANSWERED. TUI2-R3v2 ① removed the disagreement it was papering
 * over: every panel is a list with a bar on it, ↑↓ move the bar, ⏎ (or a
 * click) takes the row under it, and a digit takes its row outright.
 * One sentence, now true of every flavor for the same reason rather than
 * by careful omission.
 *
 * The two ask-only gestures keep their clauses because the ask is the
 * only flavor with a set to build and an answer to write.
 */
export const PANEL_KEYS_ROW = "panels: ↑↓ move · ⏎ or click confirms · 1-4 instant · space toggles · t types";

/** The sheet's grid: the first six bindings in two 3-column rows, the
 *  last four in two 2-column rows (the wide entries get the room). The
 *  COLUMN STOPS are the prototype's absolute positions, floored by the
 *  content (a future binding widens its column rather than overrunning
 *  it — the grid degrades to one space, never to a collision). */
const SHEET_GRID: readonly (readonly number[])[] = [
	[0, 1, 2],
	[3, 4, 5],
	[6, 7],
	[8, 9],
	[10], // UD-1: its own single-column row — no hand-tuned stop touched
];
const SHEET_STOPS: readonly (readonly number[])[] = [
	[16, 43],
	[16, 43],
	[36],
	[36],
	[],
];

/**
 * TUI2-R1 (D) — the sheet, one screen, static.
 *
 * Rows CUT at the width rather than folding: the sheet's contract with
 * the reader is "one screen", and a folded grid at 40 columns is two
 * screens pretending to be one. A narrow terminal shows fewer columns
 * of the same truth, which is the honest degradation.
 */
export function keysSheetRows(W: number): string[] {
	const p = palette();
	const cell = (i: number): string => {
		const b = KEY_BINDINGS[i];
		// DC-3: the key NAMES are the sheet's content, not a code span —
		// they borrowed the inline-code tint and became the least readable
		// thing on the one screen whose whole job is being read.
		return b === undefined ? "" : `${p.bold}${b.keys}${p.reset} ${b.what}`;
	};
	const plainCell = (i: number): string => {
		const b = KEY_BINDINGS[i];
		return b === undefined ? "" : `${b.keys} ${b.what}`;
	};
	const rows = [`${p.bold}keys${p.reset}`];
	for (let r = 0; r < SHEET_GRID.length; r += 1) {
		const indexes = SHEET_GRID[r]!;
		let row = "";
		let width = 0;
		for (let c = 0; c < indexes.length; c += 1) {
			row += cell(indexes[c]!);
			width += displayWidth(plainCell(indexes[c]!));
			const stop = SHEET_STOPS[r]![c];
			if (stop === undefined) continue; // the last column pads nothing
			const pad = Math.max(1, stop - width);
			row += " ".repeat(pad);
			width += pad;
		}
		rows.push(row);
	}
	rows.push(`${p.dim}${panelKeysRow(W)}${p.reset}`);
	return rows.map((row) => cutRow(row, W));
}

/**
 * DC-2 — the panel row degrades by CLAUSE.
 *
 * The row is 76 columns of independent clauses joined by ` · `. At 72 it
 * used to lose the tail of the last one, so `t types` became `t`: the
 * reader was told a key existed and not told what it did, on a row that
 * still looked complete. Dropping a whole clause says less; it never
 * says something false. `cutRow`'s ellipsis is the floor below this, for
 * a width that cannot hold even the first clause.
 */
function panelKeysRow(W: number): string {
	const clauses = PANEL_KEYS_ROW.split(" \u00b7 ");
	for (let n = clauses.length; n > 1; n -= 1) {
		const row = clauses.slice(0, n).join(" \u00b7 ");
		if (displayWidth(row) <= W) return row;
	}
	return clauses[0]!;
}

/** One row, cut at the width — SGR-aware, the ellipsis after the reset
 *  (the cutLine convention; duplicated here rather than imported so the
 *  strings module keeps its no-components-dependency shape). */
function cutRow(row: string, W: number): string {
	// DC-2: a cut is MARKED. This returned the surviving prefix with
	// nothing to say it was a prefix, so a row that had lost its tail read
	// as a whole row — the one thing the tree's own fold rule forbids
	// ("the honest …, never a silent truncate"). The mark costs a column,
	// so the cut lands one column earlier to pay for it.
	if (displayWidth(row.replace(/\x1b\[[0-9;]*m/g, "")) <= W) return row;
	const limit = Math.max(0, W - 1);
	let out = "";
	let width = 0;
	for (let i = 0; i < row.length; ) {
		if (row[i] === "\x1b") {
			const m = /^\x1b\[[0-9;]*m/.exec(row.slice(i))?.[0] ?? row[i]!;
			out += m;
			i += m.length;
			continue;
		}
		const cw = displayWidth(row[i]!);
		if (width + cw > limit) break;
		out += row[i]!;
		width += cw;
		i += 1;
	}
	return `${out}${palette().reset}\u2026`;
}

/** TUI2-R1 (D) — the keys as ONE line, for /help. The same table the
 *  sheet renders, joined — so the two can disagree only by deleting a
 *  test. The sheet is the readable form; this is the greppable one. */
export function keysHelpRow(): string {
	return KEY_BINDINGS.map((b) => `${b.keys} ${b.what}`).join(" · ");
}

/**
 * KC3.5 slice ⓪ (the extraction) — the /help command table.
 *
 * The rows were eight bodyLog calls in the CLI's dispatcher; they are
 * presentation, and presentation belongs here (the KC3 §1 pattern —
 * the FLOW, which is "print these on the chain, then re-prompt", stays
 * in dispatch.ts). The last row carries its own newline exactly as it
 * did inline: bodyLog splits on \n, so `exit` and `keys` land as two
 * rows from one call — the shape the KC1/KC2/KC3 gestures were added
 * to, unchanged.
 */
export function helpRows(): string[] {
	const p = palette();
	// DC-1: ONE description column. The gap used to be four spaces after
	// the name whatever the name's length, so `/help`'s description began
	// three columns left of `/compact`'s and the second column wandered
	// down the list. displayWidth is the authority, as everywhere else.
	const table: readonly (readonly [string, string])[] = [
		["/help", "print this list of commands"],
		["/think", "show the last full thinking block"],
		["/last", "show the most recent tool call's input and output"],
		// R4 (C4d): a committed row is the terminal's, and cannot be
		// re-wrapped in place (ADR-0046) — this appends it re-folded.
		["/rewrap", "re-print the recent prose at the current width"],
		["/status", "show session id, event count, and context estimate"],
		["/mode", "show the approval tier; /mode <name> switches (manual/default/accept-edits/plan/bypass)"],
		["/model", "list model profiles; /model <name|provider/model> switches"],
		["/compact", "summarize the older conversation to free context"],
		["/clear", "start a fresh conversation (the old session stays resumable)"],
		["/resume", "switch to another session; /resume <id> goes directly"],
		["exit", "leave the session"],
		// TUI2-R1 (D): the SENTENCE is deliberately unchanged. Deriving it
		// from KEY_BINDINGS would be an improvement and it would also move
		// an assertion outside the round's declared supersession classes,
		// so the sheet stays the derived surface and this row keeps its
		// words. `keysHelpRow()` exists for the round allowed to swap it;
		// until then the drift guard is the test that every binding in the
		// table is mentioned here. DC-1 changes the PADDING, not the words.
		["keys", "enter sends \u00b7 ctrl+J newline (shift+enter where encoded) \u00b7 esc stops the run \u00b7 alt+\u23ce stops it and sends this instead \u00b7 @ files \u00b7 1-4 answers an ask"],
	];
	const stop = Math.max(...table.map(([name]) => displayWidth(name))) + 4;
	const cmd = (name: string, desc: string): string => `${p.bold}${name}${p.reset}${" ".repeat(stop - displayWidth(name))}${desc}`;
	const rows = table.slice(0, -2).map(([name, desc]) => cmd(name, desc));
	// the last call carries its own newline exactly as it did inline:
	// bodyLog splits on \n, so `exit` and `keys` land as two rows from one
	// call — the shape the KC1/KC2/KC3 gestures were added to, unchanged.
	const [exitName, exitDesc] = table[table.length - 2]!;
	const [keysName, keysDesc] = table[table.length - 1]!;
	rows.push(`${cmd(exitName, exitDesc)}\n${cmd(keysName, keysDesc)}`);
	return rows;
}
