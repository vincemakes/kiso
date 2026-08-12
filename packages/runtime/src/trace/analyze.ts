/**
 * E1 (1.2.0) — slice 4, the cache-break derivation (proposal §4, ruling
 * R4b: per-segment hashes + prefix fingerprint; the BREAK COUNT is an
 * analysis-side derivation, never a recorded field).
 *
 * The cacheable prefix is every segment that is NOT the current turn —
 * freshness "fresh" is the boundary (manifest.ts). `cacheableHashes`
 * pairs the manifest segments 1:1 with the per-segment hashes and
 * drops the fresh tail, so the fingerprint and the break derivation
 * share one boundary by construction: a current-turn change alone
 * never moves the fingerprint and never counts a break.
 *
 * `prefixBreak` compares two adjacent requests' cacheable prefixes:
 * the first differing segment is the break, at its (0-based) depth;
 * a prefix that merely GREW (a new turn joined) breaks at the old
 * length. Unchanged prefixes → null (0 breaks). This is what
 * bench/trace-report.mjs and the bench render per-request (slice 5).
 */

import type { TraceSegment } from "./record.js";

/** The cacheable-prefix hashes: segments[i] ↔ hashes[i], dropping every
 *  freshness "fresh" segment (the current turn). */
export function cacheableHashes(segments: readonly TraceSegment[], hashes: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < segments.length; i++) {
		if (segments[i]!.freshness !== "fresh") out.push(hashes[i]!);
	}
	return out;
}

export interface PrefixBreak {
	/** 0-based segment index within the cacheable prefix where the
	 *  prefix first diverges (depth 0 = the system prompt). */
	readonly depth: number;
}

/** R4b: compare two adjacent requests' cacheable prefixes. null = the
 *  prefix is unchanged (0 breaks). A prefix that grew breaks at the old
 *  length — the new segment is where caching can no longer attach. */
export function prefixBreak(prev: readonly string[], next: readonly string[]): PrefixBreak | null {
	const shared = Math.min(prev.length, next.length);
	for (let i = 0; i < shared; i++) {
		if (prev[i] !== next[i]) return { depth: i };
	}
	if (prev.length !== next.length) return { depth: shared };
	return null;
}

/** Per-request breaks across a run's request sequence: request k's
 *  break is relative to request k−1; the first request has no
 *  predecessor (null). */
export function deriveBreaks(requests: readonly (readonly string[])[]): (PrefixBreak | null)[] {
	const out: (PrefixBreak | null)[] = [];
	for (let k = 0; k < requests.length; k++) {
		out.push(k === 0 ? null : prefixBreak(requests[k - 1]!, requests[k]!));
	}
	return out;
}
