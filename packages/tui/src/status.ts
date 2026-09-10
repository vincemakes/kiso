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
import { TWINKLE } from "@vincemakes/kiso-tui-cells/render";

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

/** The ~ctx estimate as the whole-percent LEFT. A non-finite ratio (no
 *  window, no estimate) yields null and the row prints "~null%" — the
 *  long-standing shape, kept on purpose: an honest null beats an
 *  invented percentage. */
function ctxLeft(ratio: number): number | null {
	return Number.isFinite(ratio) ? Math.round((1 - ratio) * 100) : null;
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
 * The RUNNING row: the rotating glyph, the wall seconds since `since`
 * (never below 1 — a run that just started still reads "1s", so the row
 * never claims a turn took no time), the streamed output tokens once the
 * count is known, the interrupt hints, and the live ctx estimate.
 *
 * KC2 §2: the hint names BOTH gestures. Esc still stops; alt+⏎ redirects
 * — stop, and do THIS instead. The row is where the gesture is taught,
 * because it is on screen exactly when the gesture is useful.
 */
export function runningStatus(glyph: string, since: number, outTokens: number | null, ctxRatio: number, tokPerSec: number | null = null): string {
	const out = outTokens !== null ? ` ↓ ${kUnit(outTokens)} tokens` : "";
	// TPS-1: after each call SETTLES within the turn, between the tokens
	// segment and the stop hint. The default is null and that is the honest
	// rule spelled as a default — the recovery flow has no per-call timing
	// state, so its row says nothing rather than guessing.
	const rate = tokPerSec !== null ? ` · ${tokPerSec} tok/s` : "";
	const seconds = Math.max(1, Math.round((Date.now() - since) / 1000));
	return `${glyph} working ${seconds}s${out}${rate} · esc stop · alt+⏎ redirect · ctx left ~${ctxLeft(ctxRatio)}%`;
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

/** The IDLE row: the approval tier as the CALLER names it, the /mode
 *  hint, the model driving the session, the TUI2-R1 meter when there is
 *  one, and the ctx estimate. Called without a meter — or with one that
 *  knows nothing — the row is byte-identical to the pre-round row. */
export function idleStatus(tier: string, model: string, ctxRatio: number, meter?: StatusMeter): string {
	const parts = [`▸ ${tier}`, "/mode to switch", model];
	if (meter?.cacheHitPct != null) parts.push(`CH ${Math.round(meter.cacheHitPct)}%`);
	// costUsd deliberately NOT rendered — see StatusMeter.costUsd.
	parts.push(`ctx left ~${ctxLeft(ctxRatio)}%`);
	if (meter?.tokPerSec != null) parts.push(`${meter.tokPerSec} tok/s`); // TPS-1: last, after the ctx estimate
	return parts.join(" · ");
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
