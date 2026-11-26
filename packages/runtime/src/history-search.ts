/**
 * ADR-0063 M0.5 — internal historical retrieval over effective history.
 *
 * A runtime function, not a model tool: it serves record debugging, the
 * retention evaluation (E1) and later the constraint matcher (M5). Nothing
 * on a run's path imports it, so it cannot move a request byte; the
 * reachability gate (history-search-reach.test.ts) holds that mechanically.
 *
 * NO SECOND INTERPRETER. Every hit is an `EffectiveEvidence` exactly as
 * `effectiveHistory` returns it; this module only filters and orders that
 * list. It never re-reads raw events, never re-derives a status, a pairing
 * or a text block.
 *
 * The query shape is the one the public `recall` tool (M1) will take, so M1
 * wraps this function rather than writing a second search:
 *
 * - `query`: literal terms, case-insensitive substring match over the
 *   evidence content (a tool result's: its tool's name too); a "quoted
 *   phrase" is one term; every term must match. A quote that never closes
 *   is a literal character of its word, on purpose: JSON tool input carries
 *   quotes, and a stray one must stay searchable rather than vanish.
 *   No regex, no stemming, no ranking model: a path, a symbol or a tool's
 *   name is found by its own characters.
 * - `seq`: the evidence that carries that seq — the event's own evidence,
 *   or the text block whose span contains it. A seq that carries no
 *   evidence (a stop, a summary, thinking) returns nothing, never a
 *   neighbour.
 * - `mode`: `"effective"` (the default) returns effective evidence only,
 *   covered evidence included with `coveredBy`; `"audit"` returns every
 *   status, the original text of a replaced input included.
 *
 * `limit` is a positive integer; anything else is refused (RangeError).
 * Both given: the evidence at `seq` that also matches `query`. Neither, or
 * a query with no terms: nothing — never "the whole history".
 * Order: newest first (descending seq, then log order within one seq).
 */
import type { Event } from "@vincemakes/kiso-core";
import { effectiveHistory, type EffectiveEvidence } from "./effective-history.js";

export type HistoryQuery = {
	readonly query?: string;
	readonly seq?: number;
	readonly mode?: "effective" | "audit";
	/** Hits returned; `total` still counts every match. Default 20. */
	readonly limit?: number;
};

export type HistorySearch = { readonly hits: readonly EffectiveEvidence[]; readonly total: number };

/** Split a query into literal, lower-cased terms; a "quoted phrase" stays whole. */
export function queryTerms(query: string): string[] {
	const terms: string[] = [];
	for (const m of query.matchAll(/"([^"]*)"|(\S+)/g)) {
		const term = (m[1] ?? m[2] ?? "").trim().toLowerCase();
		if (term !== "") terms.push(term);
	}
	return terms;
}

export function searchHistory(events: readonly Event[], q: HistoryQuery): HistorySearch {
	const limit = q.limit ?? 20;
	if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`searchHistory: limit must be a positive integer, got ${limit}`);
	const terms = q.query === undefined ? [] : queryTerms(q.query);
	if (terms.length === 0 && q.seq === undefined) return { hits: [], total: 0 };
	const audit = q.mode === "audit";
	const evidence = effectiveHistory(events, { audit });
	const matches: EffectiveEvidence[] = [];
	for (const e of evidence) {
		if (!audit && e.structuralStatus !== "effective") continue;
		if (q.seq !== undefined && !(e.seq <= q.seq && q.seq <= (e.throughSeq ?? e.seq))) continue;
		// A result's tool name is searchable with its content; a call's content starts with it.
		const text = (e.kind === "tool" && e.provenance.tool !== undefined ? `${e.provenance.tool}\n${e.content}` : e.content).toLowerCase();
		if (terms.every((t) => text.includes(t))) matches.push(e);
	}
	// Newest first; the sort is stable, so one seq keeps log order (an audit
	// replacement before its effective text).
	const newestFirst = matches.sort((a, b) => b.seq - a.seq);
	return { hits: newestFirst.slice(0, limit), total: newestFirst.length };
}
