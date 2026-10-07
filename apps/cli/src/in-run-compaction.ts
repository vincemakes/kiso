/**
 * The compaction round (owner, 2026-10-06) — a summary call inside a run,
 * as the screen sees it.
 *
 * The runtime tells the CLI when an in-run summary starts, how far its
 * output has come, and how it ended (`contextPolicy.tiers.onSummary`). The
 * running row reads `current()` on every repaint: while a summary is in
 * flight it is the `compacting · auto` row `/compact` draws, not `working`
 * with a clock that runs while nothing arrives. When the summary is kept,
 * its sizes wait here for the `summarized` event, whose COMPACTED row says
 * them (`takeKept`).
 */

import type { CompactingProgress } from "@vincemakes/kiso-tui";

export interface InRunCompaction {
	/** when the summary call started (ms) */
	readonly since: number;
	/** the covered user rounds and their estimated tokens */
	readonly rounds: number;
	readonly tokens: number;
	/** the latest report against the output budget; null before the first */
	progress: CompactingProgress | null;
}

type SummaryEvent =
	| { readonly phase: "start"; readonly reason: string; readonly info: { readonly rounds: number; readonly tokens: number } }
	| { readonly phase: "progress"; readonly progress: { readonly produced: number; readonly budget: number | null; readonly reasoningUnseen: boolean } }
	| { readonly phase: "end"; readonly outcome: "kept" | "discarded" | "failed"; readonly pre: number; readonly post: number };

let live: InRunCompaction | null = null;
let kept: { readonly pre: number; readonly post: number } | null = null;

/** The runtime's callback (create-coding-agent passes it to the tiers). */
export function onInRunSummary(event: SummaryEvent): void {
	if (event.phase === "start") {
		live = { since: Date.now(), rounds: event.info.rounds, tokens: event.info.tokens, progress: null };
		kept = null;
	} else if (event.phase === "progress") {
		if (live !== null) live.progress = { produced: event.progress.produced, budget: event.progress.budget, reasoningUnseen: event.progress.reasoningUnseen };
	} else {
		live = null;
		kept = event.outcome === "kept" ? { pre: event.pre, post: event.post } : null;
	}
}

/** The summary in flight, or null — what the running row draws. */
export function current(): InRunCompaction | null {
	return live;
}

/** The kept summary's sizes, once: the `summarized` event's row says them. */
export function takeKept(): { readonly pre: number; readonly post: number } | null {
	const k = kept;
	kept = null;
	return k;
}

/** A run that ends mid-summary (an abort) leaves nothing behind. */
export function clearInRunSummary(): void {
	live = null;
	kept = null;
}
