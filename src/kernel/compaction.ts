/**
 * L2 — compaction primitives.
 *
 * The kernel's compaction policy is identity preservation, not summary
 * (mauri ADR-0007): keep the message SHELL (id, role, position), replace the
 * content with a marker, zero LLM calls. A summary is a NEW message; it never
 * rewrites an old one. Messages are immutable (ADR-0002) — "clearing" is
 * append, not mutation.
 *
 * The idempotence predicate is the first thing here because it is the FIRST
 * kernel function demanded by a fixture: the compaction-regrowth incident
 * (uooki 2026, video pipeline) was an O(N²) growth where repeated compaction
 * re-archived messages already marked cleared, overwriting their original
 * content. One line fixed it: a marked message is never archived again.
 */

/** Marker prefix for cleared tool results. Must be unambiguous and stable. */
export const CLEARED_MARKER_PREFIX = "[content cleared — reference by revision]";

export function isClearedMarker(content: string): boolean {
	return content.startsWith(CLEARED_MARKER_PREFIX);
}

/** Idempotence gate: a message whose content is already the clear marker is
 *  never compacted again, never re-archived, never overwritten. */
export function shouldClearContent(content: string): boolean {
	return !isClearedMarker(content);
}
