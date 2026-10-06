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
 * The ~ctx estimate as the whole-percent LEFT, or `ctx ?` when there is no
 * window to divide by.
 *
 * A percentage needs a denominator. When the model's context window is not
 * KNOWN — the registry records null for it, nobody set one in the profile,
 * no env — there is no denominator, and this row's rule is the same as
 * every other number on it: a measurement, or nothing. It used to print
 * `ctx left ~null%`, which at least did not invent a figure; `ctx ?` says
 * the same thing to a reader.
 *
 * The failure this replaces is worse than either: the window fell back to
 * a hardcoded 200,000 and the row printed a confident `ctx left ~82%`
 * against a number nobody had measured. A reader had no way to tell that
 * percentage from one computed against a real window.
 */
function ctxSegment(ratio: number): string {
	return Number.isFinite(ratio) ? `ctx left ~${Math.round((1 - ratio) * 100)}%` : "ctx ?";
}

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
	const full = join(present);
	if (W === undefined || displayWidth(full) <= W) return full;
	// 1. elide every label in its middle
	let row = present.map((x) => (x.kind === "label" ? { ...x, text: elideMiddle(x.text, LABEL_ON_ROW) } : x));
	if (displayWidth(join(row)) <= W) return join(row);
	// 2. drop hints from the end, one at a time
	for (let i = row.length - 1; i >= 0; i -= 1) {
		if (row[i]!.kind !== "hint") continue;
		row = [...row.slice(0, i), ...row.slice(i + 1)];
		if (displayWidth(join(row)) <= W) return join(row);
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

/** ADR-0058 (3e): the session's tasks, as the status rows count them. */
export interface TaskCountsOnRow {
	/** running or starting */
	readonly running: number;
	/** an outcome that cannot be known, not yet looked at in `/tasks` */
	readonly unknown: number;
}

/** `● 2 tasks running · ◌ 1 unknown`, `◌ 1 task unknown` — or nothing.
 *  An unknown task is never hidden behind the panel: it is the one that
 *  needs the person most. */
export function tasksSegment(c: TaskCountsOnRow | undefined): string {
	if (c === undefined) return "";
	const n = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
	if (c.running > 0 && c.unknown > 0) return `● ${n(c.running, "task")} running · ◌ ${c.unknown} unknown`;
	if (c.running > 0) return `● ${n(c.running, "task")} running`;
	if (c.unknown > 0) return `◌ ${n(c.unknown, "task")} unknown`;
	return "";
}

export function runningStatus(
	glyph: string,
	since: number,
	outTokens: number | null,
	ctxRatio: number,
	tokPerSec: number | null = null,
	W?: number,
	retry?: RetryOnRow | null,
	// 3e: the session's tasks, and whether a running command can be moved
	// to the background now (the row teaches ctrl+b exactly then)
	tasks?: TaskCountsOnRow,
	detachable = false,
): string {
	const out = outTokens !== null ? ` ↓ ${kUnit(outTokens)} tokens` : "";
	const seconds = Math.max(1, Math.round((Date.now() - since) / 1000));
	return composeRow(`${glyph} working ${elapsedLabel(seconds)}${out}`, [
		// ADR-0005 Amendment 2: a pending retry is a FACT and sits first — it
		// is the one thing on the row that explains why nothing is arriving,
		// and a retry budget of minutes with nothing on screen reads as a
		// hung session.
		retry != null ? { kind: "fact", text: retrySegment(retry) } : null,
		// TPS-1: after each call SETTLES within the turn, between the tokens
		// segment and the stop hint. The default is null and that is the
		// honest rule spelled as a default — the recovery flow has no
		// per-call timing state, so its row says nothing rather than guessing.
		tokPerSec !== null ? { kind: "fact", text: `${tokPerSec} tok/s` } : null,
		{ kind: "fact", text: tasksSegment(tasks) },
		{ kind: "hint", text: "esc stop" },
		detachable ? { kind: "hint", text: "ctrl+b background" } : null,
		{ kind: "hint", text: "alt+⏎ redirect" },
		{ kind: "fact", text: ctxSegment(ctxRatio) },
	], W);
}

/**
 * The COMPACTING row (W18): the covered rounds, the pre-call token
 * estimate, and the elapsed seconds — all knowable before the one summary
 * call returns, which has no fraction of its own. Moved here from an
 * inline template in dispatch (0.40.0) so it composes like every other
 * row and has a place for what the launch build adds to it.
 */
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
			? `~${kUnit(tokens)} \u2192 ${meterGlyphs(progress.produced / progress.budget, BAR_ON_ROW)} ${kUnit(progress.produced)}/${kUnit(progress.budget)}`
			: `~${kUnit(tokens)} tokens`;
	return composeRow(`${glyph} compacting`, [
		// Graphite §8.7 (R3b, G7): why it is compacting — `manual` for
		// /compact, `auto` past the configured threshold — first, a fact
		why !== undefined && why !== "" ? { kind: "fact", text: why } : null,
		{ kind: "fact", text: `${rounds} rounds` },
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

/**
 * TUI2-R1 (E) — the idle row's meter: what the session has SPENT, next
 * to what it has left.
 *
 * Both fields are optional and both are omitted when unknown, because
 * the row's job is to be true rather than complete:
 *
 *   - `cacheHitPct` is cacheRead / (fresh + cacheRead) — the E2
 *     denominator (the pinned sentence: it cannot exceed 100%). A
 *     session with no usage yet has no cache hit rate, and an
 *     unmeasured cache is NOT a 0% cache, so it renders nothing.
 *   - `costUsd` is the CANONICAL cost, which is null whenever the
 *     pricing table has no rate for the route. Null renders nothing.
 *     No rate table, no number — kiso does not invent a price.
 */
export interface StatusMeter {
	readonly cacheHitPct: number | null;
	/** RETIRED from the row (the owner's 2026-08-23 directive): live
	 *  prices fluctuate and the canonical table is "an approximation,
	 *  not a bill" — a four-decimal figure on the status bar claimed a
	 *  precision the data never had. The canonical cost STAYS recorded
	 *  (trace ledger, /context); the field is kept so callers need not
	 *  change shape, and it renders NOTHING. */
	readonly costUsd: number | null;
	/** TPS-1 — the decode rate of the LAST settled call, carried into the
	 *  idle row so the figure a person watched during the turn is still
	 *  there when the turn ends. Null renders nothing (see `decodeRate`);
	 *  a new model binding starts with none, exactly as the cache figure
	 *  does (DF-0311-F1: an unmeasured binding has no measurement). */
	readonly tokPerSec: number | null;
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

/**
 * The IDLE row: the approval tier as the CALLER names it, the /mode hint,
 * the model driving the session, the TUI2-R1 meter when there is one, and
 * the ctx estimate. Called without a meter — or with one that knows
 * nothing — the row is byte-identical to the pre-round row.
 *
 * DF-0330-F1 — THE DROP ORDER. `W` is the row's budget; given one, the row
 * gives ground in a fixed order rather than letting invariant ① cut its
 * end off. Found the hard way: at 100 columns the ` · N tok/s` segment
 * never appeared and at 140 it did, because the row was 102 columns wide
 * and the segment TPS-1 added sat last.
 *
 *   1. the MODEL ID is elided in its middle. It is the only segment that
 *      varies, it is the one that grew (the owner's is 35 columns of a
 *      90-column row), and eliding it gives the row back a budget instead
 *      of re-allocating a deficit;
 *   2. `/mode to switch` is dropped. It teaches a gesture; `/mode` and `?`
 *      still exist and the row is not the only place they are taught;
 *   3. the FACTS are never dropped and never cut — the tier, CH, the ctx
 *      estimate and the rate. A row that silently drops a measurement is
 *      the defect this rule exists to prevent.
 *
 * The elision is ON THE ROW only. `/model`, the session log and the trace
 * ledger all keep the id whole — the row is a view, never the record.
 *
 * No `W` means no dropping, which is what the callers that do not know
 * their width should get: today's row, unchanged.
 */
export function idleStatus(tier: string, model: string, ctxRatio: number, meter?: StatusMeter, W?: number, floorOff = false, tasks?: TaskCountsOnRow): string {
	return composeRow(`▸ ${tier}`, [
		// 0.40.0: the catastrophe floor is on by default and says nothing;
		// OFF is the state worth seeing, and a fact beside the tier it
		// changes the meaning of.
		floorOff ? { kind: "fact", text: "floor off" } : null,
		// 3e: work still going on (or gone unknown) after the turn ended
		{ kind: "fact", text: tasksSegment(tasks) },
		{ kind: "hint", text: "/mode to switch" },
		{ kind: "label", text: model },
		meter?.cacheHitPct != null ? { kind: "fact", text: `CH ${Math.round(meter.cacheHitPct)}%` } : null,
		// costUsd deliberately NOT rendered — see StatusMeter.costUsd.
		{ kind: "fact", text: ctxSegment(ctxRatio) },
		meter?.tokPerSec != null ? { kind: "fact", text: `${meter.tokPerSec} tok/s` } : null, // TPS-1: last, after the ctx estimate
	], W);
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

/** The bar's task segment, painted: the marks coloured, the words dim. */
function tasksOnBar(c: TaskCountsOnRow): string {
	const p = palette();
	const n = (k: number, word: string): string => `${k} ${word}${k === 1 ? "" : "s"}`;
	const running = c.running > 0 ? `${p.blue}\u25cf${p.fgEnd} ${p.dim}${n(c.running, "task")} running${p.reset}` : "";
	const unknown = c.unknown > 0 ? `${p.gold}\u25cc${p.fgEnd} ${p.dim}${c.running > 0 ? `${c.unknown} unknown` : `${n(c.unknown, "task")} unknown`}${p.reset}` : "";
	return [running, unknown].filter((x) => x !== "").join(`${p.dim} \u00b7 ${p.reset}`);
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
