/**
 * E1 (1.2.0) — the request hashes (proposal §4, ruling R4b + R1a).
 *
 * Every hash is pinned to the schemaVersion's HashSpec (sha-256,
 * full hex) — `hashSpecFor(TRACE_SCHEMA_VERSION)` is checked at every
 * call, so a version bump without a re-pin fails loudly instead of
 * silently changing the algorithm. The canonical serialization is
 * JSON.stringify of the request-shaped values; the byte discipline is
 * that the same construction path (the kernel's projection) produces
 * the same serialization, which the trace-bytes gate pins end-to-end.
 */

import { createHash } from "node:crypto";
import type { Message, ToolSpec } from "@vincemakes/kiso-core";
import { TRACE_SCHEMA_VERSION, hashSpecFor } from "./record.js";

export function sha256Hex(input: string): string {
	hashSpecFor(TRACE_SCHEMA_VERSION); // the pinned algorithm, or fail loudly
	return createHash("sha256").update(input, "utf8").digest("hex");
}

export const canonicalJson = (v: unknown): string => JSON.stringify(v);

export function hashSystemPrompt(systemPrompt: string | undefined): string {
	return sha256Hex(systemPrompt ?? "");
}

export function hashToolSpecs(tools: readonly ToolSpec[] | undefined): string {
	return sha256Hex(canonicalJson(tools ?? []));
}

/** The full request projection — the same messages array the loop hands
 *  the adapter, so a retry re-serializes to an IDENTICAL hash (§1.4). */
export function hashContext(
	systemPrompt: string | undefined,
	tools: readonly ToolSpec[] | undefined,
	messages: readonly Message[],
): string {
	return sha256Hex(canonicalJson({ systemPrompt, tools, messages }));
}

/** sha-256 over the per-segment hashes of the cacheable prefix — the
 *  segments up to but NOT including the current turn (R4b). */
export function stablePrefixFingerprint(segmentHashes: readonly string[]): string {
	return sha256Hex(segmentHashes.join(""));
}
