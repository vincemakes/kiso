/**
 * KC2 §5 — the status line's FORMATTERS, extracted from the CLI (the
 * escape hatch of ADR-0043, which supersedes ADR-0041 — this comment
 * cited the superseded ADR as current AND repeated its retired "never a
 * fifth raise" promise; ADR-0043 governs the ceiling now). The split is
 * the one the ADR names: the CLI keeps the STATE (the rotating glyph,
 * the run's start instant, the live usage, whether the dock is up) and
 * the REPAINT; what a status row SAYS is presentation, and presentation
 * belongs to the terminal layer.
 *
 * Two callers built these rows independently before the move — chat's
 * REPL and the recovery flow — with the running row duplicated verbatim
 * in both. One definition now serves both, and the tier stays a
 * PARAMETER precisely because the two callers disagree on it (chat
 * spells plan's read-only posture out per W19, the recovery flow prints
 * the bare mode): the extraction must not silently unify a difference it
 * was not asked to settle.
 *
 * The rows are byte-for-byte what the CLI built before the move — the
 * v2b/v3 §03 shapes the e2e transcripts pin by substring — with ONE
 * deliberate exception: the running row's interrupt hint, which KC2 §2
 * widens to name the new gesture.
 */

import { kUnit } from "./lines.js";
import { meterCells, meterGlyphs } from "./context-ledger.js";

/** 0.40.0 — the compacting row's bar: output produced so far against the
 *  summary call's output budget (text AND reasoning — see the runtime's
 *  SummaryProgress), and whether reasoning was billed without streaming. */
export interface CompactingProgress {
	readonly produced: number;
	readonly budget: number | null;
	readonly reasoningUnseen: boolean;
}

/** The compacting row's bar width — short: it shares a row. */
const BAR_ON_ROW = 6;
import { elapsedLabel } from "@vincemakes/kiso-tui-cells";
import { TWINKLE, cutLine, palette } from "@vincemakes/kiso-tui-cells/render";
import { displayWidth, visibleWidth } from "@vincemakes/kiso-tui-cells/width";

/**
 * R3 (design §5.2) — the working glyph family is the TWINKLE, and the
 * CLI's 200ms spinner walks it exactly as it walked the four quadrant
 * blocks it replaces.
 *
 * Two reasons the quadrants had to go. §5.3: they ROTATED, and a mark
 * that turns implies progress a call of unpredictable duration does not
 * have. §4.1: the twinkle settles onto `✦`, which is the mark the
 * folded segment keeps — so the glyph a human watches while the model
 * thinks is the glyph left behind when the thought collapses into a
 * record, and nothing new appears at the transition.
 *
 * Glyphs only, no colour: intact under NO_COLOR and on any ground.
 */
export const STATUS_GLYPHS = TWINKLE;


/**
 * TPS-1 — the settled DECODE rate of one model call: its output tokens
 * over the seconds from the call's first streamed event to its usage
 * event. TTFT is excluded on purpose; this is the speed of the text
 * arriving, which is what "tokens per second" means to the person
 * watching it.
 *
 * The null rule, and every branch of it is the same principle: a number
 * on this row is a MEASUREMENT or it is absent. No output count (the
 * provider reported no usage) is not a zero. Under half a second of
 * decoding is a sample too short to divide by. A non-positive elapsed is
 * a clock, not a rate. And a call that decoded NOTHING has no rate to
 * report: `0 tok/s` would read as a measured speed and it is not one — it
 * is the absence of output, which the transcript already shows. The
 * condition is on the RENDERED INTEGER rather than on the token count, so
 * a slow trickle that rounds to the same `0` reaches the same absence for
 * the same reason.
 */
export function decodeRate(outputTokens: number | null, elapsedMs: number): number | null {
	if (outputTokens === null) return null;
	if (!Number.isFinite(elapsedMs) || elapsedMs < 500) return null;
	const rate = Math.round(outputTokens / (elapsedMs / 1000));
	return rate > 0 ? rate : null;
}

/**
 * THE ROW SEAM (0.40.0). One composer for every status row.
 *
 * Three rows grew their own string-building — the running row, the idle
 * row, and the compacting row inline in dispatch — and three features of
 * the launch build want to add to them at once (a retry state, a mode
 * and floor indicator, a compaction progress bar). Each splicing its own
 * segment into its own template is how a row ends up with two of its
 * facts cut by invariant ① at 80 columns, because nobody decided what
 * gives way first. So the decision is made HERE, once, and every row is
 * a list of typed segments:
 *
 *   - `fact`  — a measurement or a state (the tier, ctx, a rate, a retry
 *               count). NEVER dropped and never cut; a row that silently
 *               drops a measurement is the defect DF-0330-F1 fixed;
 *   - `hint`  — teaches a gesture (`esc stop`, `/mode to switch`). Dropped
 *               first, from the END, because the row is not the only
 *               place a gesture is taught;
 *   - `label` — a name that may be ELIDED in its middle (the model id),
 *               tried before any hint is dropped, because eliding gives
 *               the row its budget back instead of re-allocating a deficit.
 *
 * The first entry is the row's HEAD and is never touched. Everything is
 * joined with ` · `. With no `W` the row is the full composition — every
 * caller that does not know its width gets exactly the row it had.
 */
export interface RowSegment {
	readonly text: string;
	readonly kind: "fact" | "hint" | "label";
}

export function composeRow(head: string, segments: readonly (RowSegment | null | undefined)[], W?: number): string {
	const present = segments.filter((x): x is RowSegment => x != null && x.text !== "");
	const join = (xs: readonly RowSegment[]): string => [head, ...xs.map((x) => x.text)].join(" · ");
	// the compaction round: a fact may carry colour (the progress cells), and
	// its codes take no cells — measured without them, a plain row as before
	const width = (t: string): number => displayWidth(t.replace(/\x1b\[[0-9;]*m/g, ""));
	const full = join(present);
	if (W === undefined || width(full) <= W) return full;
	// 1. elide every label in its middle
	let row = present.map((x) => (x.kind === "label" ? { ...x, text: elideMiddle(x.text, LABEL_ON_ROW) } : x));
	if (width(join(row)) <= W) return join(row);
	// 2. drop hints from the end, one at a time
	for (let i = row.length - 1; i >= 0; i -= 1) {
		if (row[i]!.kind !== "hint") continue;
		row = [...row.slice(0, i), ...row.slice(i + 1)];
		if (width(join(row)) <= W) return join(row);
	}
	// 3. facts are never dropped: past this point the row is over budget,
	//    and it is invariant ①'s to cut — which it will do to the LAST
	//    segment, so the order of facts is the order of their importance.
	return join(row);
}

/**
 * The RUNNING row: the rotating glyph, the wall seconds since `since`
 * (never below 1 — a run that just started still reads "1s", so the row
 * never claims a turn took no time), the streamed output tokens once the
 * count is known, the interrupt hints, and the live ctx estimate.
 *
 * KC2 §2: the hint names BOTH gestures. Esc still stops; alt+⏎ redirects
 * — stop, and do THIS instead. The row is where the gesture is taught,
 * because it is on screen exactly when the gesture is useful.
 */
/** ADR-0005 Amendment 2 — a retry the kernel is waiting on, as the row
 *  shows it. `remainingMs` is how much of the wait is left; at or below
 *  zero the attempt is in flight and the countdown is gone. */
export interface RetryOnRow {
	readonly attempt: number;
	readonly maxRetries: number;
	readonly code: string;
	readonly remainingMs: number;
}

/** `retrying 3/10 · network · 4s` — ONE fact: the attempt, the budget it
 *  counts against, what failed, and how long until it is tried. Whole
 *  seconds, rounded UP, so the row never says 0s while still waiting. */
export function retrySegment(r: RetryOnRow): string {
	const head = `retrying ${r.attempt}/${r.maxRetries} · ${r.code}`;
	return r.remainingMs > 0 ? `${head} · ${Math.ceil(r.remainingMs / 1000)}s` : head;
}

/** ADR-0058 (3e, Amendment 8): the tasks kiso manages, as the status rows
 *  count them. */
export interface TaskCountsOnRow {
	/** running or starting */
	readonly running: number;
}

/** `● 2 tasks running` — or nothing. A task kiso lost track of is not a
 *  second count here: it is an event, said once in the transcript
 *  (Amendment 8). */
export function tasksSegment(c: TaskCountsOnRow | undefined): string {
	if (c === undefined || c.running <= 0) return "";
	return `● ${c.running} task${c.running === 1 ? "" : "s"} running`;
}


/**
 * The COMPACTING row (W18): the covered rounds, the pre-call token
 * estimate, and the elapsed seconds — all knowable before the one summary
 * call returns, which has no fraction of its own. Moved here from an
 * inline template in dispatch (0.40.0) so it composes like every other
 * row and has a place for what the launch build adds to it.
 */
/** The compaction round (owner, 2026-10-06) — the summary's progress in
 *  the bar's own cells (§8.9's ctx meter, `meterCells`): `▆` filled in
 *  `ink2`, the rest in the track colour. `▰▱` drew tiny in Menlo and
 *  retired from the bar; off a known ground there are no colours to tell
 *  filled from empty, so the glyphs carry it there. */
function progressCells(ratio: number, cells: number): string {
	const p = palette();
	if (p.track === "") return meterGlyphs(ratio, cells);
	const filled = Math.max(0, Math.min(cells, Math.round((Number.isFinite(ratio) ? ratio : 0) * cells)));
	return `${p.ink2}${"\u2586".repeat(filled)}${p.track}${"\u2586".repeat(cells - filled)}${p.fgEnd}`;
}

export function compactingStatus(
	glyph: string,
	rounds: number,
	tokens: number,
	elapsedSeconds: number,
	W?: number,
	retry?: RetryOnRow | null,
	progress?: CompactingProgress | null,
	why?: string,
): string {
	// 0.40.0: with a budget to measure against, the covered size and the bar
	// are ONE fact — what went in, and how much of the output budget has
	// come out. Without a budget the row keeps the covered size alone: the
	// bar never invents a denominator.
	const covered =
		progress != null && progress.budget !== null && progress.budget > 0
			? `~${kUnit(tokens)} \u2192 ${progressCells(progress.produced / progress.budget, BAR_ON_ROW)} ${kUnit(progress.produced)}/${kUnit(progress.budget)}`
			: `~${kUnit(tokens)} tokens`;
	return composeRow(`${glyph} compacting`, [
		// Graphite §8.7 (R3b, G7): why it is compacting — `manual` for
		// /compact, `auto` past the configured threshold — first, a fact
		why !== undefined && why !== "" ? { kind: "fact", text: why } : null,
		// the compaction round: one round is a round
		{ kind: "fact", text: `${rounds} round${rounds === 1 ? "" : "s"}` },
		{ kind: "fact", text: covered },
		// why the figure jumped when the usage landed — a HINT, so a narrow
		// row gives it up before the bar, the seconds or the retry
		progress?.reasoningUnseen === true && progress.budget !== null ? { kind: "hint", text: "incl. unstreamed reasoning" } : null,
		{ kind: "fact", text: `${Math.max(0, elapsedSeconds)}s` },
		// ADR-0005 Amendment 2: the summary call retries under the kernel's
		// policy, and a retry here is the same fact it is on the running row.
		retry != null ? { kind: "fact", text: retrySegment(retry) } : null,
	], W);
}


/** DF-0330-F1 — how far a LABEL may be squeezed on the ROW; the model id
 *  is the one there is. Twenty visible columns keeps a head and a tail:
 *  `deepseek-v…s-on-0910` still says which binding is driving, and the
 *  tail is where the parts that distinguish one id from its neighbours
 *  live (`-flash`, `-0910`). Read by `composeRow`. */
const LABEL_ON_ROW = 20;

/** Elide in the MIDDLE, keeping the head and the tail. A string already
 *  within budget is returned untouched, so this is a no-op for every
 *  ordinary model name.
 *
 *  Budgeted in DISPLAY COLUMNS, not code points. A first version sliced
 *  code points and a wide-character id came out at 28 columns while the
 *  function claimed 20 — which would have put the row straight back over
 *  its budget and handed it to invariant ①'s cut, the exact defect this
 *  whole change exists to prevent. No such model id exists today; the
 *  guarantee should not depend on that staying true. */
function elideMiddle(text: string, max: number): string {
	if (displayWidth(text) <= max) return text;
	const chars = [...text];
	const room = max - 1; // the ellipsis costs one column
	const headBudget = Math.ceil(room / 2);
	let head = "";
	for (const c of chars) {
		if (displayWidth(head + c) > headBudget) break;
		head += c;
	}
	let tail = "";
	const tailBudget = room - displayWidth(head);
	for (let i = chars.length - 1; i >= 0; i -= 1) {
		if (displayWidth(chars[i]! + tail) > tailBudget) break;
		tail = chars[i]! + tail;
	}
	return `${head}…${tail}`;
}


/** TUI2-R1 (E) — the cache hit rate the status row shows, from the usage
 *  the CLI already tracks. The denominator is the TOTAL the model was
 *  given (fresh + cacheRead), which is the E2 ruling's own: cacheRead
 *  over fresh alone once rendered 923%. No input at all → null, never a
 *  zero. */
export function cacheHitPct(usage: { in: number | null; cache: number | null }): number | null {
	const fresh = usage.in;
	const cached = usage.cache;
	if (fresh === null || cached === null) return null;
	const total = fresh + cached;
	return total > 0 ? (cached / total) * 100 : null;
}

// ---- Graphite §8.9 / §8.7 — the status bar and the live row ----

/**
 * Graphite §8.9 — what the status bar says: the session and its health.
 * The CLI keeps the state and hands this over; the compositor composes the
 * row at paint time, because the drop order (§8.5) runs across both sides
 * of the row and only the paint knows the width and the `ctrl+o` state.
 */
export interface BarInput {
	/** The mode as the chip says it: `default`, `plan · read-only`, … */
	readonly mode: string;
	/** Full access (the old bypass) wears the failure colour (§8.9). */
	readonly modeAlert?: boolean;
	/** The main-sync round (owner, 2026-09-30): the don't-ask switch is on —
	 *  a second chip, gold (the person's standing choice), beside the tier's. */
	readonly dontAsk?: boolean;
	readonly floorOff: boolean;
	readonly model: string;
	/** The share of the window USED (0..1), and the compaction tiers as
	 *  shares of the same window; null when the window is not known. */
	readonly ctx: { readonly used: number; readonly soft: number; readonly hard: number } | null;
	readonly tokPerSec: number | null;
	/** The main-sync round (ADR-0058 3e): the session's tasks — running, and
	 *  unknown not yet looked at in `/tasks`. Absent or all zero, nothing. */
	readonly tasks?: TaskCountsOnRow;
	readonly branch: string | null;
	readonly folder: string | null;
}

/** The ctx meter's width in cells (§8.9). */

/**
 * §8.9 — the ctx meter: ten `▆` cells with the used share filled, then the
 * percentage used. Filled cells take `ink2` below the soft compaction tier,
 * gold from the soft tier to the hard one, the failure colour past the hard
 * tier; the empty cells are `track`. There is no marker inside the bar —
 * the tier shows as colour only (owner, 2026-09-28). Off a known ground
 * the colours carry nothing, so the meter is the percentage alone (§1.2:
 * the fact survives without the colour). `ctx ?` when the window is not
 * known.
 */
export function ctxMeter(ctx: BarInput["ctx"]): string {
	if (ctx === null || !Number.isFinite(ctx.used)) return "ctx ?";
	const used = Math.max(0, ctx.used);
	const pct = `${Math.round(used * 100)}%`;
	const p = palette();
	if (p.track === "") return `ctx ${pct}`;
	// the cells follow the percentage SHOWN: `ctx 0%` is an empty meter,
	// and from 1% at least one cell is filled (owner, 2026-09-29 — a lit
	// cell beside `0%` read as a contradiction); one rule with /context's
	return `${p.dim}ctx${p.reset} ${meterCells(used, ctx.soft, ctx.hard)} ${p.dim}${pct}${p.reset}`;
}

/**
 * §8.9 — the status bar, composed for `W` cells. Left: the mode chip,
 * `floor off`, `/mode to switch`, the model and its effort, the ctx meter,
 * the decode rate. The cache share is the seal's (owner, 2026-09-29: every
 * run's closing row already says it), not the bar's. Right: the branch, the folder, and the
 * `ctrl+o` switch while a card has rows behind the key.
 *
 * §8.5 — what gives way, in order: the `ctrl+o` hint, the folder (the
 * terminal title names it too), the branch, the model's middle, and last
 * `/mode to switch` — the one place a newcomer meets modes. The facts
 * never drop; past that the row is invariant ①'s to cut.
 *
 * On a known ground the chip is a surface and the segments are spaced; off
 * one the head is today's `▸ <mode>` and the segments are joined with ` · `
 * — the same facts, in words that survive without colour.
 */
export function statusBar(b: BarInput, W: number, expand: "expand all" | "collapse all" | null): string {
	const p = palette();
	const painted = p.washDone !== "";
	const sep = painted ? "  " : " · ";
	const tierChip = painted ? `${b.modeAlert === true ? p.fail : ""}${p.washDone} ${b.mode} ${p.washEnd}${b.modeAlert === true ? p.fgEnd : ""}` : `▸ ${b.mode}`;
	// the switch is not a tier, so it is not in the tier's chip: a chip of its
	// own, never dropped — it changes what kiso does as much as the tier does
	const chip = b.dontAsk !== true ? tierChip : painted ? `${tierChip}  ${p.gold}${p.washDone} don't ask ${p.washEnd}${p.fgEnd}` : `${tierChip} · don't ask`;
	const fail = (s: string): string => (painted ? `${p.fail}${s}${p.fgEnd}` : s);
	const dim = (s: string): string => `${p.dim}${s}${p.reset}`;
	// the bar's words are quiet (§1.2: grey chrome); off a known ground each
	// side is ONE dim span — the shape the status row always had
	const quiet = (s: string): string => (painted ? dim(s) : s);
	type Seg = { text: string; drop: number };
	// drop: 0 = never; otherwise the order it gives way in (1 first)
	const left: (Seg | null)[] = [
		b.floorOff ? { text: fail("floor off"), drop: 0 } : null,
		// the main-sync round (ADR-0058 3e, §8.9): the session's tasks, right
		// after the mode as 0.46.0's status row has them (owner, 2026-10-06): a
		// FACT, which never gives way — `●` in the machine's blue (running), `◌`
		// in gold (an outcome nobody can know is the one that needs the
		// person, §4); the words quiet like the rest of the bar
		tasksSegment(b.tasks) === "" ? null : { text: painted ? tasksOnBar(b.tasks!) : tasksSegment(b.tasks), drop: 0 },
		{ text: quiet("/mode to switch"), drop: 4 },
		{ text: b.model, drop: 0 },
		{ text: ctxMeter(b.ctx), drop: 0 },
		b.tokPerSec !== null ? { text: quiet(`${b.tokPerSec} tok/s`), drop: 0 } : null,
	];
	const right: (Seg | null)[] = [
		b.branch !== null ? { text: painted ? `${p.blue}${b.branch}${p.fgEnd}` : b.branch, drop: 3 } : null,
		b.folder !== null ? { text: quiet(b.folder), drop: 2 } : null,
		expand !== null ? { text: quiet(`ctrl+o ${expand}`), drop: 1 } : null,
	];
	let model = b.model;
	const compose = (dropped: number): string => {
		const l = left.filter((x): x is Seg => x !== null && (x.drop === 0 || x.drop > dropped)).map((x) => (x.text === b.model ? quiet(model) : x.text));
		const r = right.filter((x): x is Seg => x !== null && (x.drop === 0 || x.drop > dropped)).map((x) => x.text);
		const lt = painted ? [chip, ...l].join(sep) : dim([chip, ...l].join(sep));
		if (r.length === 0) return lt;
		const rt = painted ? r.join("  ") : dim(r.join("  "));
		const gap = W - visibleWidth(lt) - visibleWidth(rt);
		return gap >= 2 ? `${lt}${" ".repeat(gap)}${rt}` : `${lt}  ${rt}`;
	};
	const fits = (row: string): boolean => visibleWidth(row) <= W;
	let row = "";
	for (const level of [0, 1, 2, 3]) {
		row = compose(level);
		if (fits(row)) return row;
	}
	// the model's middle gives way before `/mode to switch` does (DF-0330-F1)
	model = elideMiddle(b.model, LABEL_ON_ROW);
	for (const level of [3, 4]) {
		row = compose(level);
		if (fits(row)) return row;
	}
	return cutLine(row, W);
}

/** The bar's task segment, painted: the mark coloured, the words dim.
 *  The main sync (0.46.2, Amendment 8): the gold `◌ N unknown` beside it
 *  retired — a task kiso lost track of is said once in the transcript, a
 *  TASK row, not counted on the bar ("running" beside "may be running"
 *  read as a contradiction to the owner). */
function tasksOnBar(c: TaskCountsOnRow): string {
	const p = palette();
	return c.running > 0 ? `${p.blue}\u25cf${p.fgEnd} ${p.dim}${c.running} task${c.running === 1 ? "" : "s"} running${p.reset}` : "";
}

/**
 * §8.7 — the LIVE ROW's words for a running turn: `working` for the whole
 * turn, whatever the model is doing (it never switches to "thinking" —
 * what the model thinks is in the stream), the elapsed, the output tokens,
 * the decode rate. A pending retry replaces it. The keys ride the row's
 * right end.
 */
export function workingRow(glyph: string, since: number, outTokens: number | null, tokPerSec: number | null, W: number, retry?: RetryOnRow | null, detachable = false): string {
	// a pending retry REPLACES `working` while it lasts (§8.7): it is the one
	// thing that explains why nothing is arriving (ADR-0005 Amendment 2),
	// and its countdown is the row's pulse — whole seconds, rounded up, so
	// it never says 0s while still waiting
	if (retry != null) {
		const wait = retry.remainingMs > 0 ? ` · next try in ${Math.ceil(retry.remainingMs / 1000)}s` : "";
		return liveRow(`↻ retrying ${retry.attempt}/${retry.maxRetries} · ${retry.code}${wait}`, ["esc gives up"], W);
	}
	const out = outTokens !== null ? ` · ↓ ${kUnit(outTokens)}` : "";
	const seconds = Math.max(1, Math.round((Date.now() - since) / 1000));
	const facts = [`${glyph} working ${elapsedLabel(seconds)}${out}`, ...(tokPerSec !== null ? [`${tokPerSec} tok/s`] : [])].join(" · ");
	// the main-sync round (ADR-0058 3e): ctrl+b exactly while a running
	// command can be moved to the background — it gives way after esc
	if (detachable) return liveRow(facts, ["esc stop \u00b7 ctrl+b background \u00b7 \u23ce steer \u00b7 alt+\u23ce redirect", "esc stop \u00b7 ctrl+b background \u00b7 \u23ce steer", "esc stop \u00b7 ctrl+b background", "esc stop"], W);
	return liveRow(facts, ["esc stop · ⏎ steer · alt+⏎ redirect", "esc stop · ⏎ steer", "esc stop"], W);
}

/** §8.7 — a live row: its mark in the mark column (column 0), its facts
 *  from the content edge, its keys right-aligned; the keys give way from
 *  the right when the row is short, the facts never (past them the row is
 *  cut). */
export function liveRow(facts: string, keys: readonly string[], W: number): string {
	const p = palette();
	const lead = facts;
	for (const k of [...keys, ""]) {
		if (k === "") return visibleWidth(lead) <= W ? lead : cutLine(lead, W);
		const gap = W - visibleWidth(lead) - visibleWidth(k);
		if (gap >= 2) return `${lead}${" ".repeat(gap)}${p.dim}${k}${p.reset}`;
	}
	return cutLine(lead, W);
}
