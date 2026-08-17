/**
 * KC2 §5 — the status line's FORMATTERS, extracted from the CLI (the
 * ADR-0041 escape hatch: extraction, never a fifth raise). The split is
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

import { kUnit } from "./render.js";

/** v3 §03/§05 — the working glyph family; the CLI's 200ms spinner walks
 *  it and hands each glyph back to `runningStatus`. */
export const STATUS_GLYPHS = ["▖", "▘", "▝", "▗"] as const;

/** The ~ctx estimate as the whole-percent LEFT. A non-finite ratio (no
 *  window, no estimate) yields null and the row prints "~null%" — the
 *  long-standing shape, kept on purpose: an honest null beats an
 *  invented percentage. */
function ctxLeft(ratio: number): number | null {
	return Number.isFinite(ratio) ? Math.round((1 - ratio) * 100) : null;
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
export function runningStatus(glyph: string, since: number, outTokens: number | null, ctxRatio: number): string {
	const out = outTokens !== null ? ` ↓ ${kUnit(outTokens)} tokens` : "";
	const seconds = Math.max(1, Math.round((Date.now() - since) / 1000));
	return `${glyph} working ${seconds}s${out} · esc stop · alt+⏎ redirect · ctx left ~${ctxLeft(ctxRatio)}%`;
}

/** The IDLE row: the approval tier as the CALLER names it, the /mode
 *  hint, the model driving the session, and the ctx estimate. */
export function idleStatus(tier: string, model: string, ctxRatio: number): string {
	return `▸ ${tier} · /mode to switch · ${model} · ctx left ~${ctxLeft(ctxRatio)}%`;
}
