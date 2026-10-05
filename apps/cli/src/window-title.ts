/**
 * The terminal's window title (0.39.1, the owner's call).
 *
 * kiso set none, so a tab read whatever the shell left there — the
 * directory the shell happened to be in and the absolute path of a node
 * binary, identically for every kiso in every tab. The title is the one
 * place a terminal shows which session a tab holds without the user
 * switching to it, and it was the only screen kiso never wrote to.
 *
 * Graphite §8.10 — the title is kiso's, the session's name when the
 * person gave it one, and the folder (the card round, owner 2026-10-05):
 *
 *     kiso — <folder>                       ready or working: no mark
 *     kiso · needs you — <folder>           an approval, a question, an
 *                                           unknown outcome to decide
 *     kiso · <name> — <folder>              named with `/name`
 *
 * DECLARED REVERSAL of two rulings. The working tab's `✦` (owner,
 * 2026-09-28, §4.1's one declared exception): a tab that changes on every
 * turn is noise, and the owner retired the mark. And 0.39.1's name from
 * the first substantive prompt (`sessionTitle`): a tab says kiso; the
 * resume picker and `kiso sessions` keep showing the derived name. The
 * title changes when the state changes and never on a tick: a ticking
 * title churns tab bars. No bell and no notification — nothing interrupts
 * the person (owner, 2026-09-28). On exit the ready form is written, so a
 * closed session never leaves a waiting mark behind.
 *
 * WHAT IT WRITES. OSC 0, BEL-terminated — icon name and window title in
 * one sequence, the form every terminal that supports either accepts. It
 * goes STRAIGHT to stdout, deliberately outside the compositor: a title
 * occupies no cell and no column, so it is not in the width accounting
 * and must not be a cell that the repaint could move, cut, or scroll.
 *
 * WHAT IT NEVER WRITES. Anything at all when stdout is not a TTY. An OSC
 * into a pipe is bytes in someone's output, and the pipe-identity gates
 * exist because that has been a real defect before.
 *
 * NO RESTORE ON EXIT. Putting back what was there first requires reading
 * it, which no terminal reliably answers; the shell repaints its own
 * title on the next prompt anyway. A guess written on the way out would
 * be a title kiso invented, which is worse than one it left.
 *
 * AND NO `process.title`. The reference implementation sets one; kiso
 * does not, because two gates in this repo said no and the benefit was
 * that `ps` would print `kiso` instead of a node path.
 *
 *  - It overwrites the process's ARGV memory, so a renamed process shows
 *    as `kiso` with its arguments simply gone. The subagent's
 *    concurrency probe counts live children by matching `chat
 *    sub-parent-` in the command column; six renamed children were
 *    indistinguishable from each other and from nothing.
 *  - Setting it is not free on this platform: 14 ms measured for the
 *    first assignment on the machine this was written on, 7 ms for the
 *    second. A synchronous stall of that size on the main thread while a
 *    3,000-line paste is arriving wedges the PTY in both directions —
 *    the UD-1 byte-exact paste gate deadlocked reproducibly and passed
 *    the moment the assignment was removed.
 *
 * The window title is what was asked for; the process name was a detail
 * that came with it, and it costs more than it is worth.
 */

import { basename } from "node:path";
import { displayWidth, widthCut } from "@vincemakes/kiso-tui-cells/width";
import { escapeTerminal } from "@vincemakes/kiso-tui-cells/render";

/** OSC 0 — "set icon name and window title". */
export const OSC_TITLE_PREFIX = "\u001b]0;";
/** BEL, the terminator the reference form uses (ST works too; BEL is the
 *  one older terminals accept without argument). */
export const OSC_TITLE_SUFFIX = "\u0007";

/** The name's share of the tab, in CELLS. A tab strip gives a title far
 *  less than a row, and the workspace — which says WHERE, the thing a
 *  human scanning tabs is usually after — must survive the cut. */
const TITLE_CELLS = 40;

/** Graphite §8.10 — what the session is doing, as the title says it. */
export type TitleState = "ready" | "working" | "needs-you";

/** Bidi controls and invisible format characters: in a title they can
 *  reorder or hide what a tab says (U+061C, U+200B–U+200F, U+202A–U+202E,
 *  U+2060–U+2069, U+FEFF). */
const INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/**
 * What may reach a title: `escapeTerminal` (the same definition of "safe
 * on a terminal" the rendered surfaces use — a BEL would end the sequence
 * and an ESC would begin another), then the bidi and invisible format
 * code points, which reorder or hide text without being control bytes.
 */
export function sanitizeTitle(text: string): string {
	return escapeTerminal(text).replace(INVISIBLE, "");
}

/** The title for a state, a name (null unless `/name` gave one) and a
 *  folder. The name is cut at 40 cells, by CELLS: a wide character counts
 *  two. */
export function titleText(state: TitleState, name: string | null, folder: string): string {
	const place = sanitizeTitle(folder);
	const safe = name === null ? "" : sanitizeTitle(name);
	const who = displayWidth(safe) > TITLE_CELLS ? `${widthCut(safe, TITLE_CELLS - 1)}…` : safe;
	const parts = ["kiso", ...(state === "needs-you" ? ["needs you"] : []), ...(who === "" ? [] : [who])];
	return `${parts.join(" · ")} — ${place}`;
}

/** The title in a state, with no IO — the whole rule, testable. */
export function windowTitleText(workspace: string, st: TitleState = "ready", named: string | null = null): string {
	return titleText(st, named, workspace);
}

/** What was last written, so a repaint of the same title writes nothing.
 *  The title is re-derived on every bind, every `/name` and every state
 *  change; most of those derive what is already on screen. */
let shown: string | null = null;
let state: TitleState = "ready";
let lastCwd: string | null = null;
let lastName: string | null = null;

/** Graphite R3d: the session's `/name` (null when unnamed) — set where the
 *  session is bound and when `/name` changes it. */
export function setTitleName(name: string | null): void {
	lastName = name;
	write();
}

function write(): void {
	if (process.stdout.isTTY !== true || lastCwd === null) return;
	const text = windowTitleText(basename(lastCwd) || lastCwd, state, lastName);
	if (text === shown) return;
	shown = text;
	process.stdout.write(`${OSC_TITLE_PREFIX}${text}${OSC_TITLE_SUFFIX}`);
}

/**
 * Write the title for this session. Called where the session is BOUND
 * (one place for all three entry points — first start, `/resume <id>`,
 * and a switch), so a tab never names the folder the user just left.
 */
export function paintWindowTitle(cwd = process.cwd()): void {
	lastCwd = cwd;
	write();
}

/** The session's state changed (§8.10): a turn began or ended, a panel
 *  asks the person or has been answered, the process is exiting. Writes
 *  only when the title it derives differs from the one shown. */
export function setTitleState(next: TitleState): void {
	state = next;
	write();
}

/** The state the title shows now — a panel that asks restores it after. */
export function titleState(): TitleState {
	return state;
}
