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
import { cutLine, escapeTerminal, palette } from "./render.js";
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
export function projectTrustView(root: string, files: readonly TrustArtifact[], shownRoot: string = root): PanelView {
	return {
		flavor: "simple",
		name: "project trust",
		title: root,
		speaker: "kiso",
		statusText: "❯ project trust",
		args: { kind: "text", lines: projectTrustRows(files) },
		ruleOverride: "trust this project's .kiso?",
		// Graphite P1b (owner, 2026-09-30): kiso's own question, and the
		// answers say what they do, like the other gates'
		asked: { question: "trust this project?", facts: [shownRoot], prose: "Its .kiso folder holds these files. kiso loads none of them until you trust the project." },
		simpleOptions: ["trust it", "not now"],
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
export function uncertainView(name: string, executionId: string, target: readonly string[] = []): PanelView {
	// Graphite P1b: the panel quotes WHAT may have run — the command, or the
	// call's target as its tool card names it (the CLI reads it from the
	// execution record) — where it used to quote the execution id twice
	const what = name === "shell" ? "command" : "call";
	return {
		flavor: "simple",
		name: "uncertain execution",
		title: `${name} (${executionId})`,
		speaker: "kiso",
		statusText: "❯ uncertain execution",
		args: { kind: "text", lines: target.length > 0 ? [...target] : [executionId] },
		ruleOverride: "an interrupted execution may have applied — rerun it?",
		asked: { question: "rerun it?", facts: [name], prose: `kiso stopped before this ${what}'s result was saved, so it may already have run. Check the workspace, then choose.` },
		simpleOptions: ["rerun it", "abandon it"],
		fallbackQuestion: `interrupted execution: ${escapeTerminal(name)} (${executionId}) — rerun it? (y)es / (n)o `,
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
export function unansweredAskView(executionId: string, questions: readonly string[] = []): PanelView {
	const many = questions.length > 1;
	return {
		flavor: "simple",
		name: "unanswered question",
		title: `ask_user (${executionId})`,
		speaker: "kiso",
		statusText: "❯ unanswered question",
		// Graphite P1b: the question itself, quoted — not its execution id
		args: { kind: "text", lines: questions.length > 0 ? [...questions] : [executionId] },
		ruleOverride: "an unanswered question was interrupted — ask it again?",
		asked: { question: many ? "ask them again?" : "ask it again?", facts: ["never answered"], prose: `The session stopped while ${many ? "these questions" : "this question"} waited for you.` },
		simpleOptions: ["ask it again", "drop it"],
		fallbackQuestion: `an unanswered question was interrupted (${executionId}) — ask it again? (y)es / (n)o `,
	};
}

/**
 * 0.40.0 (the owner's session) — the cold resume. A session resumed 27
 * minutes after its last request re-sent a 727k prefix the provider had
 * evicted. The first request after a long pause pays for the whole prefix
 * either way; compacting first turns that one expensive request into a
 * summary call, and every turn after it is small. The line names the size
 * and the age, so the person can judge.
 */
export function coldResumeLine(tokens: number, minutesAgo: number): string {
	return `this session is ${Math.round(tokens / 1000)}k tokens, last used ${minutesAgo} min ago, and its cache is cold`;
}

export function coldResumeView(tokens: number, minutesAgo: number): PanelView {
	const line = coldResumeLine(tokens, minutesAgo);
	const k = `${Math.round(tokens / 1000)}k`;
	return {
		flavor: "simple",
		name: "cold cache",
		title: `compact first? (${k} tokens, ${minutesAgo} min idle)`,
		speaker: "kiso",
		statusText: "❯ resumed session",
		// Graphite P1b: the size and the idle time ride the band; one
		// sentence says what happens and what compacting costs — nothing is
		// quoted, so the gutter is empty
		args: { kind: "text", lines: [] },
		asked: { question: "compact first?", facts: [`${k} tokens`, `idle ${minutesAgo} min`], prose: `The cache expired while the session was idle, so the next request sends all ${k} tokens again. Compacting first is one summary call; the turns after it are small.` },
		ruleOverride: `${line} — compact first? (one summary call, then every turn is cheap)`,
		simpleOptions: ["compact first", "keep the full history"],
		fallbackQuestion: `${line} — compact first? (y)es / (n)o `,
	};
}

/** An extension as the banner names it — the live `connecting` flag is
 *  the MCP bridge's in-flight state ("mcp (connecting…)"). Structural on
 *  purpose: the runtime's KisoExtension satisfies it without this
 *  package importing the runtime. */
export interface BannerExtension {
	readonly name: string;
	readonly connecting?: boolean;
	/** A fact about the extension in this session, printed in parentheses
	 *  after its name — "ask (off in dontAsk)", with the don't-ask switch
	 *  on. `connecting` wins. */
	readonly note?: string;
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
	const label = (e: BannerExtension): string =>
		e.connecting === true ? `${e.name} (connecting…)` : e.note !== undefined ? `${e.name} (${e.note})` : e.name;
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
 * sheet and `keysHelpRow`. A sheet that has drifted from the keys is
 * worse than no sheet, and the only way to make drift impossible is to
 * have one table and no second copy of it.
 *
 * The order is the sheet's reading order, two bindings to a row — the
 * sheets round (owner, 2026-10-06): the sheet is two columns, left then
 * right, so the table is read in pairs. Grouped by WHAT A HUMAN IS DOING:
 * putting something in and changing course, then finding things, then
 * seeing more, then editing, then the clipboard, then the shell. A key
 * with two spellings is named by one (alt+⏎ also answers to ctrl+⏎,
 * alt+←→ to ctrl+←→); ctrl+w stays named because it is the word deletion
 * that works on every terminal (§8.6). `ctrl+t`, `ctrl+g` and the `!`
 * gestures joined from /help's table, which named them and the sheet did
 * not; `? this sheet` left, because `?` is how you got here.
 */
export const KEY_BINDINGS: readonly KeyBinding[] = [
	{ keys: "enter", what: "send" },
	{ keys: "esc", what: "stop the run" },
	{ keys: "ctrl+j", what: "newline (shift+\u23ce too)" },
	{ keys: "alt+\u23ce", what: "stop it, send this" },
	{ keys: "@", what: "files" },
	{ keys: "/", what: "commands" },
	{ keys: "\u2191\u2193", what: "history \u00b7 take back a steer" },
	{ keys: "tab", what: "complete" },
	{ keys: "ctrl+o", what: "expand all" },
	// R5 — the transcript viewer. It has to be HERE or it does not exist:
	// R4a retired the printed key from the fold row on the ground that a
	// row cannot say which fold a key opens, and the sheet is where the
	// discoverability moved. A surface nobody can find is not a feature.
	{ keys: "ctrl+r", what: "transcript" },
	{ keys: "ctrl+t", what: "hide thinking" },
	{ keys: "ctrl+g", what: "edit in $EDITOR" },
	// E1 §1/§3 — the editor's daily three (word motion, word deletion,
	// copy); three encodings of the word gestures reach the same code.
	{ keys: "alt+\u2190\u2192", what: "word motion" },
	{ keys: "alt+\u232b", what: "delete a word (ctrl+w too)" },
	{ keys: "ctrl+z", what: "undo" },
	{ keys: "ctrl+y", what: "redo" },
	{ keys: "ctrl+x", what: "copy the answer" },
	// REL-0152-D15/D16 — the image paste. It is on the sheet because a
	// terminal's own Cmd+V only ever pastes TEXT: a human with an image on
	// the clipboard has no way to discover this key by trying the obvious
	// one, which is exactly the case the sheet exists for.
	{ keys: "ctrl+v", what: "attach an image" },
	{ keys: "!cmd", what: "run it and send it" },
	{ keys: "!!cmd", what: "run it, show it here only" },
	// the main-sync round (ADR-0058 3e): the background key, beside the
	// shell gestures it serves; the live row teaches it while it applies
	{ keys: "ctrl+b", what: "background a command" },
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

/** Graphite R3e — how every read-only sheet closes, on its last row: esc
 *  closes it, and what is typed goes to the input. The sheets round
 *  (owner, 2026-10-06) gave the keys sheet the same row and the same
 *  behaviour as `/status`.
 *
 *  DECLARED REVERSAL (the sheets round): the keys sheet's last row was
 *  `PANEL_KEYS_ROW` (`panels: ↑↓ move · ⏎ confirms · digits act on their
 *  row · t types`), with its own grid (`SHEET_GRID`, `SHEET_STOPS`) and
 *  a clause-dropping ladder (DC-2). Every panel's own key row now says
 *  that panel's keys (§8.2, P3, P4), the row had gone stale (`t types`
 *  left `/model` in P3), and the grid was a second and third table that
 *  had to agree with KEY_BINDINGS by hand. */
export const SHEET_CLOSE = "esc closes \u00b7 typing goes to the input";

/** R8b — the band's own opening row: a labelled rule at full width.
 *
 *  Moved here from the @ picker, unchanged in every byte, because the
 *  keys sheet needs it too and `components.ts` already imports this
 *  module — the dependency only runs one way. `at-picker.ts` re-exports
 *  it, so every existing import site is untouched. */
export function bandHeader(label: string, W: number): string {
	const p = palette();
	const head = `\u2500\u2500\u2500 ${label} `;
	const line = `${head}${"\u2500".repeat(Math.max(1, W - head.length))}`;
	let out = "";
	let w = 0;
	for (const ch of line) {
		const cw = displayWidth(ch);
		if (w + cw > Math.max(1, W)) break;
		out += ch;
		w += cw;
	}
	// Graphite §8.1 (R3a): the hairline in `line`, the band's name bold
	// gold — the band names itself; off a known ground, one dim span
	if (p.line === "" || p.gold === "") return `${p.dim}${out}${p.reset}`;
	const at = out.indexOf("\u2500 ") + 2;
	// the NAME is the label up to its first ` · `; what follows (a scope,
	// a count, a key) is the band's facts, dim
	const sep = label.indexOf(" \u00b7 ");
	const nameEnd = Math.min(out.length, at + (sep < 0 ? label.length : sep));
	const labelEnd = Math.min(out.length, at + label.length);
	return `${p.line}${out.slice(0, at)}${p.fgEnd}${p.bold}${p.gold}${out.slice(at, nameEnd)}${p.reset}${p.dim}${out.slice(nameEnd, labelEnd)}${p.reset}${p.line}${out.slice(labelEnd)}${p.fgEnd}`;
}

/**
 * TUI2-R1 (D), the sheets round (owner, 2026-10-06) — the keys sheet: the
 * band's named hairline, the bindings two to a row at the content edge,
 * the key in ink and what it does dim, each column measured over the
 * whole table so they line up, and the closing row. Narrower than two
 * columns need, it is one column in the table's order. Rows CUT at the
 * width rather than folding: the sheet's contract is "one screen".
 *
 * DECLARED REVERSAL: the sheet began at column 0 with the keys bold and
 * hand-set column stops (DC-1/DC-3); §1.8's one content edge and the
 * command list's name/description tones replace them.
 */
export function keysSheetRows(W: number): string[] {
	const p = palette();
	const width = (col: readonly KeyBinding[], f: (b: KeyBinding) => string): number => Math.max(0, ...col.map((b) => displayWidth(f(b))));
	const cell = (b: KeyBinding, kw: number, dw: number): string => `${b.keys}${" ".repeat(kw - displayWidth(b.keys) + 2)}${p.dim}${b.what}${p.reset}${dw === 0 ? "" : " ".repeat(dw - displayWidth(b.what))}`;
	const left = KEY_BINDINGS.filter((_, i) => i % 2 === 0);
	const right = KEY_BINDINGS.filter((_, i) => i % 2 === 1);
	const kl = width(left, (b) => b.keys);
	const dl = width(left, (b) => b.what);
	const kr = width(right, (b) => b.keys);
	const dr = width(right, (b) => b.what);
	const rows = [bandHeader("keys", W)];
	if (2 + kl + 2 + dl + 3 + kr + 2 + dr <= W) {
		for (let i = 0; i < left.length; i += 1) {
			const r = right[i];
			rows.push(`  ${cell(left[i]!, kl, r === undefined ? 0 : dl)}${r === undefined ? "" : `   ${cell(r, kr, 0)}`}`);
		}
	} else {
		const k = width(KEY_BINDINGS, (b) => b.keys);
		for (const b of KEY_BINDINGS) rows.push(`  ${cell(b, k, 0)}`);
	}
	rows.push(`  ${p.dim}${SHEET_CLOSE}${p.reset}`);
	return rows.map((row) => cutLine(row, W));
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
/** The rows `/help` prints, as DATA — the one place that says which
 *  commands exist. `helpRows` renders it; `slashCommandNames` asks it
 *  whether a word is a command at all, so the dispatcher's error line
 *  cannot drift from the list the same screen prints. */
const HELP_TABLE: readonly (readonly [string, string])[] = [
	["/help", "print this list of commands"],
	["/think", "show the last full thinking block"],
	["/last", "show the most recent tool call's input and output"],
	// R4 (C4d): a committed row is the terminal's, and cannot be
	// re-wrapped in place (ADR-0046) — this appends it re-folded.
	["/rewrap", "re-print the recent prose at the current width"],
	["/copy", "copy the last answer (raw markdown) — ctrl+x does the same"],
	// ADR-0058 (3e): the session's tasks, and the key that makes one
	["/tasks", "list this session's background tasks; stop one or show its output"],
	["/status", "show session id, event count, and context estimate"],
	["/name", "name this session · /name shows it · /name - clears it"],
	// 0.40.6: what kiso runs with, and where each value came from
	["/settings", "show the settings in force, each value's source, and how to change it"],
	// A command with no row is a command nobody can find. `/context` has
	// been dispatchable since TUI2-R1 slice 6 and was never listed here,
	// so the only way to learn it existed was to read the source.
	["/context", "show where the context went — the per-request rent ledger"],
	["/mode", "show the approval tier; /mode <name> switches (default/accept-edits/plan/full-access)"],
	// the modes round: the don't-ask switch, beside the tiers it composes
	// with. `/dont-ask` is nine characters, as `/settings` is, so the
	// computed stop does not move.
	["/dont-ask", "never stop for you: what would ask is refused — /dont-ask off undoes it"],
	["/model", "list model profiles; /model <name|provider/model> switches"],
	["/compact", "summarize the older conversation to free context"],
	["/clear", "start a fresh conversation (the old session stays resumable)"],
	["/resume", "switch to another session; /resume <id> goes directly"],
	// §2.5: the conversation is untouched — this rereads what kiso was
	// built with, not what it has said.
	["/reload", "reread extensions, skills and config into this session"],
	// 0.40.0: a skill is a user turn — its SKILL.md, then your args. The
	// `/<name>` row says the rule a person needs before they install a
	// skill named like a command: the command wins.
	["/skills", "list the installed skills, and any that cannot load"],
	["/skill", "run a skill as your turn: /skill <name> [args]"],
	["/<name>", "runs the skill <name> when no command above has that name"],
	// §2.2: the two shell gestures and their one escape. They sit
	// beside the slash commands because that is what a reader is
	// looking for when they look here, even though `!` is not one.
	// §2.3: the switch belongs beside ctrl+o's job, and a gesture the
	// sheet does not name is a gesture nobody uses (DC-30, DC-36).
	["ctrl+t", "hide thinking to one line, and show it again (remembered)"],
	// ADR-0058 (3e): beside ctrl+t — the running row teaches it when it
	// applies; this is where it can be found the rest of the time
	["ctrl+b", "move the running command to the background (twice inside tmux)"],
	// §2.4: the composer, in your own editor. It names the variables
	// because that is what a reader has to set for it to work.
	["ctrl+g", "edit the composer in $VISUAL or $EDITOR — the text comes back unsent"],
	["!<cmd>", "run a shell command and send it with its output as your turn"],
	["!!<cmd>", "run one and show it here only — the model never sees it"],
	["\\!", "send a line that really starts with ! (the only escape)"],
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

/** The slash commands `/help` lists. The keys, the `!` gestures and the
 *  `/<name>` skill rule in the table are not commands and are not here. */
export function slashCommandNames(): readonly string[] {
	return HELP_TABLE.map(([name]) => name).filter((n) => /^\/[a-z]+$/.test(n));
}

export function helpRows(): string[] {
	const p = palette();
	// DC-1: ONE description column. The gap used to be four spaces after
	// the name whatever the name's length, so `/help`'s description began
	// three columns left of `/compact`'s and the second column wandered
	// down the list. displayWidth is the authority, as everywhere else.
	const table = HELP_TABLE;
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
