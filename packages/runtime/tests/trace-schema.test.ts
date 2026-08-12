/**
 * E1 (1.2.0) — slice 1, the schema gate (work-order §6; proposal §1.1 as
 * adopted by the R1 ruling "adopt as-is, keep ts, per-round additive").
 *
 * The record shape is the 1.2.0 field-set lock: a canonical record is
 * accepted, and every deviation (extra field, missing field, bad enum,
 * wrong schemaVersion, malformed seqRange) is rejected. The
 * closed-field-set gate (ruling R1a) is bidirectional: the test
 * enumerates the spec'd keys as a const, so a new type field without a
 * const entry — or a const entry without a type field — goes red. R1a
 * also pins the hash/fingerprint algorithms to the schemaVersion: a
 * version bump without a pinned hash spec is impossible by construction.
 */

import { describe, expect, it } from "vitest";
import {
	HASH_SPEC_BY_VERSION,
	TRACE_RECORD_FIELDS,
	TRACE_SCHEMA_VERSION,
	TRACE_SEGMENT_FIELDS,
	hashSpecFor,
	validateTraceLine,
	validateTraceRecord,
} from "../src/trace/record.js";
import type { TraceRecord } from "../src/trace/record.js";

/** A fully populated canonical record — every optional field present
 *  (lineageLink), so its key set is exactly the type's full key set. */
const canonicalRecord: TraceRecord = {
	schemaVersion: TRACE_SCHEMA_VERSION,
	kind: "request",
	requestId: "9f3a7c11-6b3e-4f2a-9d0e-1c2b3a4d5e6f",
	runId: "run-0143",
	requestIndex: 0,
	retryAttempt: 0,
	provider: "openai-compat",
	model: "deepseek-chat",
	adapterVersion: "0.1.40",
	systemPromptHash: "a".repeat(64),
	toolSchemaHash: "b".repeat(64),
	contextHash: "c".repeat(64),
	contextManifest: [
		{ role: "system", seqRange: null, estTokens: 210, freshness: "cache_read" },
		{ role: "tools", seqRange: null, estTokens: 88, freshness: "cache_read" },
		{ role: "turn", seqRange: [1, 12], estTokens: 140, freshness: "cache_read" },
		{ role: "current_turn", seqRange: [13, 13], estTokens: 41, freshness: "fresh" },
	],
	stablePrefixFingerprint: "d".repeat(64),
	freshInput: 41,
	cacheRead: 12410,
	cacheWrite: null,
	output: 320,
	latencyMs: 2841.5,
	ttftMs: 402,
	toolCalls: ["read_file", "write_file"],
	outcome: "ok",
	lineageLink: {
		parentSessionId: "session-0142",
		parentRunId: "run-0142",
		parentInvocationSeq: 7,
		role: "user",
	},
	ts: 1_753_400_000_000,
};

const canonicalSegment = canonicalRecord.contextManifest[3]!;

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A structural copy widened to a plain object so the tests can delete
 *  required fields and inject unknown ones — the compile-time closed set
 *  rejects those on the typed record, which is exactly the point. */
const looseCopy = (v: TraceRecord): Record<string, unknown> => copy(v) as unknown as Record<string, unknown>;

describe("E1 slice 1 — the record schema gate (proposal §1.1)", () => {
	it("canonical record: accepted, and stable across a JSON round-trip", () => {
		expect(validateTraceRecord(canonicalRecord)).toBe(true);
		expect(validateTraceRecord(copy(canonicalRecord))).toBe(true);
	});

	it("every required field missing is rejected", () => {
		for (const key of TRACE_RECORD_FIELDS) {
			if (key === "lineageLink") continue; // the one optional field
			const broken = looseCopy(canonicalRecord);
			delete broken[key];
			expect(validateTraceRecord(broken), `missing ${key}`).toBe(false);
		}
		// the optional field may be absent
		const noLineage = looseCopy(canonicalRecord);
		delete noLineage.lineageLink;
		expect(validateTraceRecord(noLineage)).toBe(true);
	});

	it("extra unknown fields are rejected (the closed field set)", () => {
		const withExtra = looseCopy(canonicalRecord);
		withExtra.bogus = true;
		expect(validateTraceRecord(withExtra)).toBe(false);
		const segmentWithExtra = { ...canonicalSegment, extras: 1 };
		expect(validateTraceRecord({ ...canonicalRecord, contextManifest: [segmentWithExtra] })).toBe(false);
	});

	it("bad enum values are rejected", () => {
		// the compile-time closed set rejects these on the typed record —
		// widened to a plain object, the runtime validator must too
		const withBadOutcome = looseCopy(canonicalRecord);
		withBadOutcome.outcome = "partial";
		expect(validateTraceRecord(withBadOutcome)).toBe(false);
		const withBadKind = looseCopy(canonicalRecord);
		withBadKind.kind = "response";
		expect(validateTraceRecord(withBadKind)).toBe(false);
		const badFreshness = looseCopy(canonicalRecord);
		(badFreshness.contextManifest as Array<Record<string, unknown>>)[3]!.freshness = "stale";
		expect(validateTraceRecord(badFreshness)).toBe(false);
		const badRole = looseCopy(canonicalRecord);
		(badRole.contextManifest as Array<Record<string, unknown>>)[3]!.role = "round";
		expect(validateTraceRecord(badRole)).toBe(false);
	});

	it("schemaVersion is pinned to the current version", () => {
		expect(validateTraceRecord({ ...canonicalRecord, schemaVersion: 2 })).toBe(false);
		const noVersion = looseCopy(canonicalRecord);
		delete noVersion.schemaVersion;
		expect(validateTraceRecord(noVersion)).toBe(false);
	});

	it("the closed-field-set gate is bidirectional (R1a): type fields and the spec'd const agree exactly", () => {
		// A field added to the type but not the const → the typed canonical
		// record carries it → key sets diverge → red. A const entry without
		// a type field → the sample cannot carry it → red.
		expect(Object.keys(canonicalRecord).sort()).toEqual([...TRACE_RECORD_FIELDS].sort());
		expect(Object.keys(canonicalSegment).sort()).toEqual([...TRACE_SEGMENT_FIELDS].sort());
		// dedupe guard: the consts must not repeat a key (a duplicate entry
		// would mask a removed field)
		expect(new Set(TRACE_RECORD_FIELDS).size).toBe(TRACE_RECORD_FIELDS.length);
		expect(new Set(TRACE_SEGMENT_FIELDS).size).toBe(TRACE_SEGMENT_FIELDS.length);
	});

	it("R1a: schemaVersion pins the hash and fingerprint algorithms", () => {
		expect(HASH_SPEC_BY_VERSION[TRACE_SCHEMA_VERSION]).toEqual({
			algorithm: "sha-256",
			output: "full-hex",
		});
		expect(hashSpecFor(TRACE_SCHEMA_VERSION)).toEqual({ algorithm: "sha-256", output: "full-hex" });
		// a version with no pinned algorithm cannot be used
		expect(() => hashSpecFor(2)).toThrow(/no hash spec pinned/i);
		// and the record's hashes are sha-256 full-hex by construction
		const HEX_64 = /^[0-9a-f]{64}$/;
		for (const key of ["systemPromptHash", "toolSchemaHash", "contextHash", "stablePrefixFingerprint"] as const) {
			expect(canonicalRecord[key], key).toMatch(HEX_64);
		}
	});

	it("seqRange is a thin pointer: null, or [a, b] with 0 ≤ a ≤ b integers", () => {
		expect(validateTraceRecord({ ...canonicalRecord, contextManifest: [{ ...canonicalSegment, seqRange: null }] })).toBe(true);
		expect(validateTraceRecord({ ...canonicalRecord, contextManifest: [{ ...canonicalSegment, seqRange: [7, 7] }] })).toBe(true);
		expect(validateTraceRecord({ ...canonicalRecord, contextManifest: [{ ...canonicalSegment, seqRange: [5, 3] }] })).toBe(false);
		expect(validateTraceRecord({ ...canonicalRecord, contextManifest: [{ ...canonicalSegment, seqRange: [1.5, 3] }] })).toBe(false);
		expect(validateTraceRecord({ ...canonicalRecord, contextManifest: [{ ...canonicalSegment, seqRange: [-1, 3] }] })).toBe(false);
		expect(validateTraceRecord({ ...canonicalRecord, contextManifest: [{ ...canonicalSegment, seqRange: [1, 2, 3] }] })).toBe(false);
	});

	it("numeric fields are typed", () => {
		expect(validateTraceRecord({ ...canonicalRecord, latencyMs: "fast" })).toBe(false);
		expect(validateTraceRecord({ ...canonicalRecord, requestIndex: -1 })).toBe(false);
		expect(validateTraceRecord({ ...canonicalRecord, requestIndex: 1.5 })).toBe(false);
		expect(validateTraceRecord({ ...canonicalRecord, retryAttempt: "2" })).toBe(false);
		expect(validateTraceRecord({ ...canonicalRecord, contextManifest: [{ ...canonicalSegment, estTokens: 12.5 }] })).toBe(false);
		expect(validateTraceRecord({ ...canonicalRecord, ttftMs: null })).toBe(false); // locked: number, 0 = unknown
		expect(validateTraceRecord({ ...canonicalRecord, ts: "2026-08-12" })).toBe(false);
	});

	it("the usage quartet honors the provider-raw nulls", () => {
		expect(validateTraceRecord({ ...canonicalRecord, cacheWrite: 0 })).toBe(true);
		expect(validateTraceRecord({ ...canonicalRecord, freshInput: null })).toBe(false); // locked: number, never faked but never null
		expect(validateTraceRecord({ ...canonicalRecord, cacheRead: "12" })).toBe(false);
		expect(validateTraceRecord({ ...canonicalRecord, output: undefined })).toBe(false);
	});

	it("toolCalls and lineageLink are shaped", () => {
		expect(validateTraceRecord({ ...canonicalRecord, toolCalls: [1] })).toBe(false);
		expect(validateTraceRecord({ ...canonicalRecord, toolCalls: ["read_file", "read_file"] })).toBe(true);
		const lineageBroken = looseCopy(canonicalRecord);
		delete (lineageBroken.lineageLink as Record<string, unknown>).parentInvocationSeq;
		expect(validateTraceRecord(lineageBroken)).toBe(false);
		expect(validateTraceRecord({ ...canonicalRecord, lineageLink: { ...canonicalRecord.lineageLink!, parentInvocationSeq: 7.5 } })).toBe(false);
	});

	it("the ledger line kinds validate (header / request / run_end / crash)", () => {
		const header = { schemaVersion: 1, kind: "header", sessionId: "s", kisoVersion: "1.2.0", createdAt: 1_753_400_000_000 };
		const runEnd = { schemaVersion: 1, kind: "run_end", runId: "run-0143", ts: 1_753_400_000_000, lastRequestIndex: 4 };
		const crash = { schemaVersion: 1, kind: "crash", ts: 1_753_400_000_000, note: "no run_end" };
		expect(validateTraceLine(header)).toBe(true);
		expect(validateTraceLine(runEnd)).toBe(true);
		expect(validateTraceLine(crash)).toBe(true);
		expect(validateTraceLine(canonicalRecord)).toBe(true);
		expect(validateTraceLine({ kind: "bogus" })).toBe(false);
		expect(validateTraceLine({ ...header, extra: 1 })).toBe(false);
		expect(validateTraceLine({ ...runEnd, lastRequestIndex: "4" })).toBe(false);
	});
});
