/**
 * E1 (1.2.0) — the Request Trace record schema (proposal §1.1 as adopted
 * by the R1 ruling: "adopt as-is, keep ts, per-round additive"). This is
 * the 1.2.0 field-set lock: every field below is spec'd, and the
 * closed-field-set gate (ruling R1a) pins the shape bidirectionally —
 * `TRACE_RECORD_FIELDS`/`TRACE_SEGMENT_FIELDS` must stay in exact
 * agreement with the interfaces, or trace-schema.test.ts goes red.
 *
 * R1a: `schemaVersion` pins BOTH the record shape AND the hash /
 * fingerprint algorithms (`HASH_SPEC_BY_VERSION`). A version bump must
 * pin a spec for the new version before any writer can use it
 * (`hashSpecFor` throws otherwise).
 *
 * The ledger is OUT-side (ADR-0051 §6): versionable, never part of the
 * correctness ABI. These types are runtime-internal.
 *
 * E2 (1.3.0) — schemaVersion 2: the record gains the `canonical` block
 * (E2 proposal §1.5 Case A — the nested block, ruled 2026-08-13; raw
 * quartet stays as provider observation above it). The validators accept
 * BOTH generations (R1d-1): a v1 sidecar has no canonical block and reads
 * as defaults at every consumer — never a crash.
 *
 * E3 (0.2.1) — schemaVersion 3: the record gains the `rent` block — the
 * static rent ledger, one line per surface (trace/rent.ts). The v3
 * writers record it; v1/v2 sidecars keep reading as defaults (R1d-1,
 * R2-1): no rent block = no rent lines = the zero-rent reading, never a
 * crash.
 *
 * TUI2-R3v2 (0.12.0) — schemaVersion 4: the record gains the OPTIONAL
 * `purpose` marker (the safer-options seam, adjudicated 2026-08-18). A
 * session can now make a request that belongs to no run — a side query
 * (session.sideQuery) — and a ledger that could not tell one from a run
 * request would make every rent audit guesswork. `purpose` is absent on
 * run requests and present on side queries, naming what the request was
 * FOR ("safer-options"). Optional by construction: adding a required
 * field would have invalidated every v3 record ever written, and the
 * whole generation-compat discipline exists to prevent exactly that.
 */

/** schemaVersion: 4 for 0.12.0 (the optional `purpose` marker). Version
 *  1 = the 1.2.0 shape, 2 = the 1.3.0 shape, 3 = the 0.2.1 shape; all
 *  kept for generation-compat reads (R1d-1, R2-1). Algorithm and shape
 *  changes bump it (ADR-0051 §6 OUT-side versioning). */
export const TRACE_SCHEMA_VERSION = 4;

/** The versions a reader may meet in a ledger. v1 and v2 records are
 *  accepted (generation-compat) and read as defaults — no canonical
 *  block (v1), no rent block (v1, v2). */
export const TRACE_SCHEMA_VERSIONS: Readonly<Set<number>> = new Set([1, 2, 3, TRACE_SCHEMA_VERSION]);

import { PRICING_TABLE_V1, priceFor, pricingTableFor, validateCanonicalUsage } from "../usage/canonical.js";
import type { CanonicalUsage } from "../usage/canonical.js";
import { validateRentLine, type RentLine } from "./rent.js";

export type Freshness = "fresh" | "cache_read" | "cache_write";
/** That is the complete set for 1.2.0. */

export type Outcome = "ok" | "provider_error" | "aborted";
/** That is the complete set for 1.2.0. (Truncation surfaces as "aborted"
 *  when the stream ends before settle; refined in E5 if needed.) */

export interface TraceSegment {
	role: "system" | "tools" | "turn" | "current_turn";
	/** Thin pointer into the event log: [firstSeq, lastSeq] inclusive of the
	 *  events that produced this segment. null for system/tools (not events). */
	seqRange: [number, number] | null;
	estTokens: number; // estimateTokens (chars/4, core compaction.ts:28)
	freshness: Freshness; // assembly-time structural estimate, see §1.3
}
/** That is the complete set for 1.2.0. */

export interface TraceRecord {
	schemaVersion: 4;
	kind: "request";
	requestId: string; // crypto.randomUUID() per adapter call — W2's reverse-reference anchor
	runId: string;
	requestIndex: number; // 0-based ordinal of the adapter call within the run
	retryAttempt: number; // count of prior calls in this run with an identical request hash (see §1.4)
	provider: string; // config adapter identity, e.g. "openai-compat" | "anthropic"
	model: string;
	adapterVersion: string | null; // adapter package version, resolved once at tracer init; null on failure (soft-fail)
	systemPromptHash: string; // sha-256 hex of the composed system prompt (see §4)
	toolSchemaHash: string; // sha-256 hex of the tool specs (registry.toSpecs())
	contextHash: string; // sha-256 of the canonical serialization of the full request projection
	contextManifest: TraceSegment[]; // one segment per turn (see §1.3)
	/** Per-segment content hashes, indexed 1:1 with contextManifest
	 *  (segment i's canonical serialization — R4b's analysis-side data
	 *  source: the cache-break derivation needs the LIST, not the
	 *  aggregated fingerprint). Sizing note: 64 hex chars × segments
	 *  per request. */
	segmentHashes: string[];
	stablePrefixFingerprint: string; // sha-256 over the per-segment hashes of the cacheable prefix (see §4)
	/** The usage quartet is PROVIDER-RAW — never a billing surface.
	 *  Canonical/billing usage lives in the `canonical` block (E2); these
	 *  fields are observation only (a provider may count a token a dozen
	 *  ways; billing must not). */
	freshInput: number; // provider-raw usage, never normalized — normalization is E2's
	cacheRead: number;
	cacheWrite: number | null; // openai-compat honestly reports null; anthropic reports real
	output: number;
	/** E2 — the canonical record of the same raw quartet (the pinned
	 *  sentence: input is FRESH-ONLY; total = input + cacheRead + cacheWrite
	 *  is the derived quantity). Formalizes the quartet by construction —
	 *  the validator pins the equality — and carries the cost from the
	 *  versioned pricing table (every cost records its table version). */
	canonical: CanonicalUsage;
	/** E3 — the static rent ledger: one line per surface (system:base,
	 *  system:ext:<name>, tool:<name>, envelope), counts never payloads —
	 *  see trace/rent.ts. v3 requires the block; a v1/v2 sidecar has none
	 *  and reads as the zero-rent ledger (R2-1). */
	rent: RentLine[];
	latencyMs: number; // call → settle, wall clock
	ttftMs: number; // call → first yielded adapter event
	toolCalls: string[]; // tool names invoked in this turn, in order
	outcome: Outcome;
	lineageLink?: {
		parentSessionId: string;
		parentRunId: string;
		parentInvocationSeq: number;
		role: string;
	}; // ADR-0051 §2 B2a quartet, absent when unknown (see §5)
	/** TUI2-R3v2 ③ (v4) — what this request was FOR, when it was not a
	 *  run's own work. ABSENT on every run request (the overwhelming
	 *  majority) and present on a side query (session.sideQuery), naming
	 *  its purpose: "safer-options". A consumer separating on-demand rent
	 *  from run rent reads this field and needs no heuristic. */
	purpose?: string;
	ts: number; // Date.now() at settle — added to the work-order field list (justification §1.5)
}
/** That is the complete set for 1.2.0. */

// ── Ledger kinds (proposal §1.2 — the file's line vocabulary) ────────────
// Exactly four kinds, each carrying schemaVersion. run_end/crash exist so
// that a ledger hole (an ABSENT request) is explainable as a crash rather
// than as a writer bug — "every request has exactly one trace" stays
// checkable.

export interface HeaderLine {
	schemaVersion: 4;
	kind: "header";
	sessionId: string;
	kisoVersion: string;
	createdAt: number;
}

export interface RunEndLine {
	schemaVersion: 4;
	kind: "run_end";
	runId: string;
	ts: number;
	lastRequestIndex: number;
}

export interface CrashLine {
	schemaVersion: 4;
	kind: "crash";
	ts: number;
	note: string;
}

export type TraceLine = HeaderLine | TraceRecord | RunEndLine | CrashLine;

// ── R1a: the hash contract is pinned per schemaVersion ────────────────────
// A version without a pinned spec cannot be written (hashSpecFor throws),
// so "bump the schema" and "re-pin the algorithms" are the same ritual.

export interface HashSpec {
	readonly algorithm: "sha-256";
	readonly output: "full-hex";
}

export const HASH_SPEC_BY_VERSION: Readonly<Record<number, HashSpec>> = {
	1: { algorithm: "sha-256", output: "full-hex" },
	2: { algorithm: "sha-256", output: "full-hex" }, // E2 — the algorithms do not change
	3: { algorithm: "sha-256", output: "full-hex" }, // E3 — same algorithms, re-pinned (the E2 ritual)
	4: { algorithm: "sha-256", output: "full-hex" }, // TUI2-R3v2 — `purpose` is a marker, not an input to any hash; re-pinned by the same ritual
};

export function hashSpecFor(version: number): HashSpec {
	const spec = HASH_SPEC_BY_VERSION[version];
	if (spec === undefined) throw new Error(`no hash spec pinned for trace schemaVersion ${version}`);
	return spec;
}

// ── The closed-field-set gate (R1a) ───────────────────────────────────────
// Trace-schema.test.ts asserts Object.keys of a fully populated record is
// EXACTLY this set (both directions).

/** The 1.2.0 field set (schemaVersion 1) — kept verbatim for
 *  generation-compat reads of old sidecars (R1d-1): a v1 record has no
 *  canonical block and reads as defaults at every consumer. */
export const TRACE_RECORD_FIELDS_V1 = [
	"schemaVersion",
	"kind",
	"requestId",
	"runId",
	"requestIndex",
	"retryAttempt",
	"provider",
	"model",
	"adapterVersion",
	"systemPromptHash",
	"toolSchemaHash",
	"contextHash",
	"contextManifest",
	"segmentHashes",
	"stablePrefixFingerprint",
	"freshInput",
	"cacheRead",
	"cacheWrite",
	"output",
	"latencyMs",
	"ttftMs",
	"toolCalls",
	"outcome",
	"lineageLink",
	"ts",
] as const;

/** The 1.3.0 field set (schemaVersion 2) = the v1 set + `canonical`. */
export const TRACE_RECORD_FIELDS_V2 = [...TRACE_RECORD_FIELDS_V1, "canonical"] as const;

/** The 0.2.1 field set (schemaVersion 3) = the v2 set + `rent`. */
export const TRACE_RECORD_FIELDS_V3 = [...TRACE_RECORD_FIELDS_V2, "rent"] as const;

/** The 0.12.0 field set (schemaVersion 4) = the v3 set + `purpose`.
 *  TUI2-R3v2 ③: `purpose` is OPTIONAL — a run request omits it entirely,
 *  a side query names what it was for. It is listed in TRACE_RECORD_OPTIONAL
 *  below so the closed-set gate accepts a record without it. */
export const TRACE_RECORD_FIELDS = [...TRACE_RECORD_FIELDS_V3, "purpose"] as const;

/** The fields the closed-set check does not require to be present. */
export const TRACE_RECORD_OPTIONAL = ["purpose"] as const;

export const TRACE_SEGMENT_FIELDS = ["role", "seqRange", "estTokens", "freshness"] as const;

// ── Validators ────────────────────────────────────────────────────────────
// Strict by design: extra keys are rejected (the closed set), so a
// misspelled field can never silently enter the ledger.

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const keysOf = (v: unknown): string[] => (isRecord(v) ? Object.keys(v) : []);

const isNonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const isHex64 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** The closed set, both directions: no key outside the spec, and every
 *  spec'd key present except the explicit optional ones. */
const hasClosedKeys = (v: unknown, spec: readonly string[], optional: readonly string[] = []): boolean => {
	const keys = keysOf(v);
	if (keys.some((k) => !spec.includes(k))) return false;
	const optionalSet = new Set(optional);
	return spec.every((k) => optionalSet.has(k) || keys.includes(k));
};

const VALID_SEGMENT_ROLES = new Set(["system", "tools", "turn", "current_turn"]);
const VALID_FRESHNESS = new Set<unknown>(["fresh", "cache_read", "cache_write"]);
const VALID_OUTCOMES = new Set<unknown>(["ok", "provider_error", "aborted"]);

function isValidSeqRange(v: unknown): boolean {
	if (v === null) return true;
	if (!Array.isArray(v) || v.length !== 2) return false;
	const [a, b] = v;
	return isNonNegInt(a) && isNonNegInt(b) && a <= b;
}

export function validateTraceSegment(v: unknown): v is TraceSegment {
	if (!isRecord(v) || !hasClosedKeys(v, TRACE_SEGMENT_FIELDS)) return false;
	if (typeof v.role !== "string" || !VALID_SEGMENT_ROLES.has(v.role)) return false;
	if (!isValidSeqRange(v.seqRange)) return false;
	if (!isNonNegInt(v.estTokens)) return false;
	if (!VALID_FRESHNESS.has(v.freshness)) return false;
	return true;
}

export function validateTraceRecord(v: unknown): v is TraceRecord {
	if (!isRecord(v)) return false;
	const version = v.schemaVersion;
	// generation-compat (R1d-1, R2-1): a v1 sidecar has no canonical
	// block, a v2 sidecar has no rent block — both read as defaults,
	// accepted, never a crash; the current version is fully checked
	// (shape + the canonical block + the rent ledger).
	// TUI2-R3v2 ③: v3 joins the generation-compat set — a v3 sidecar has
	// no `purpose` on any record, which reads as "every request was a run
	// request", the true statement about a ledger written before side
	// queries existed.
	if (version !== 1 && version !== 2 && version !== 3 && version !== TRACE_SCHEMA_VERSION) return false;
	const fields =
		version === 1 ? TRACE_RECORD_FIELDS_V1 : version === 2 ? TRACE_RECORD_FIELDS_V2 : version === 3 ? TRACE_RECORD_FIELDS_V3 : TRACE_RECORD_FIELDS;
	if (!hasClosedKeys(v, fields, ["lineageLink", ...TRACE_RECORD_OPTIONAL])) return false;
	if (v.purpose !== undefined && (typeof v.purpose !== "string" || v.purpose === "")) return false;
	if (v.kind !== "request") return false;
	if (typeof v.requestId !== "string" || typeof v.runId !== "string") return false;
	if (!isNonNegInt(v.requestIndex) || !isNonNegInt(v.retryAttempt)) return false;
	if (typeof v.provider !== "string" || typeof v.model !== "string") return false;
	if (v.adapterVersion !== null && typeof v.adapterVersion !== "string") return false;
	if (!isHex64(v.systemPromptHash) || !isHex64(v.toolSchemaHash) || !isHex64(v.contextHash)) return false;
	if (!isHex64(v.stablePrefixFingerprint)) return false;
	if (!Array.isArray(v.contextManifest) || !v.contextManifest.every(validateTraceSegment)) return false;
	// segmentHashes must mirror the manifest 1:1 — a misaligned list
	// would silently corrupt the break derivation (R4b)
	if (
		!Array.isArray(v.segmentHashes) ||
		v.segmentHashes.length !== v.contextManifest.length ||
		!v.segmentHashes.every(isHex64)
	)
		return false;
	if (!isNumber(v.freshInput) || !isNumber(v.cacheRead)) return false;
	if (v.cacheWrite !== null && !isNumber(v.cacheWrite)) return false;
	if (!isNumber(v.output) || !isNumber(v.latencyMs)) return false;
	if (!isNumber(v.ttftMs)) return false; // 0 = unknown, never null (locked set)
	if (!Array.isArray(v.toolCalls) || !v.toolCalls.every((t) => typeof t === "string")) return false;
	if (typeof v.outcome !== "string" || !VALID_OUTCOMES.has(v.outcome)) return false;
	if (v.lineageLink !== undefined) {
		const l = v.lineageLink;
		if (!isRecord(l)) return false;
		if (typeof l.parentSessionId !== "string" || typeof l.parentRunId !== "string") return false;
		if (!isNonNegInt(l.parentInvocationSeq)) return false;
		if (typeof l.role !== "string") return false;
	}
	if (version !== 1) {
		// the canonical block: the schema's invariants machine-checked
		if (!validateCanonicalUsage(v.canonical)) return false;
		const c = v.canonical;
		// the block formalizes the raw quartet — a divergence means the
		// derivation drifted (a future bug, caught at the ledger)
		if (c.input !== v.freshInput || c.cacheRead !== v.cacheRead || c.output !== v.output || c.cacheWrite !== v.cacheWrite)
			return false;
		// cost consistency: recomputed from the components × the version's
		// pinned table, at the record's own route (the route context lives
		// in the record; the standalone schema cannot check this). A null
		// costUsd is the R5b-④c absent stamp (the table has no rate for
		// this route) — nothing to recompute against, accepted. The
		// cross-check runs only for builtin-id records: a foreign table's
		// consistency is the billing layer's accounting, not the ledger's.
		if (c.costUsd !== null && c.pricingTableId === PRICING_TABLE_V1.id) {
			const expected = priceFor(
				v.provider,
				{ input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite },
				pricingTableFor(c.pricingTableVersion),
			);
			// non-null for the builtin table by construction (both real
			// routes + the mirror fallback) — a null here is a code bug,
			// and an epsilon check has nothing to compare
			if (expected !== null && Math.abs(c.costUsd - expected) > 1e-6) return false;
		}
	}
	if (version === TRACE_SCHEMA_VERSION) {
		// the rent block: every line validates (closed fields, non-empty
		// surface, non-negative integer chars, the estTokens == ceil(chars/4)
		// cross-check — R6). v1/v2 sidecars have no block (R2-1).
		if (!Array.isArray(v.rent) || !v.rent.every(validateRentLine)) return false;
	}
	if (!isNumber(v.ts)) return false;
	return true;
}

export function validateTraceLine(v: unknown): v is TraceLine {
	if (!isRecord(v)) return false;
	// both ledger generations are readable (R1d-1); the per-kind shapes are
	// identical across 1 → 2 — only the request line's field set differs
	// (v1 lacks the canonical block), handled by validateTraceRecord's
	// version dispatch
	if (!TRACE_SCHEMA_VERSIONS.has(v.schemaVersion as number)) return false;
	switch (v.kind) {
		case "header":
			return (
				hasClosedKeys(v, ["schemaVersion", "kind", "sessionId", "kisoVersion", "createdAt"]) &&
				typeof v.sessionId === "string" &&
				typeof v.kisoVersion === "string" &&
				isNumber(v.createdAt)
			);
		case "request":
			return validateTraceRecord(v);
		case "run_end":
			return (
				hasClosedKeys(v, ["schemaVersion", "kind", "runId", "ts", "lastRequestIndex"]) &&
				typeof v.runId === "string" &&
				isNumber(v.ts) &&
				// -1 = the run made no adapter calls (an empty run still
				// settles cleanly); anything below that is not a request index
				typeof v.lastRequestIndex === "number" &&
				Number.isInteger(v.lastRequestIndex) &&
				v.lastRequestIndex >= -1
			);
		case "crash":
			return (
				hasClosedKeys(v, ["schemaVersion", "kind", "ts", "note"]) &&
				isNumber(v.ts) &&
				typeof v.note === "string"
			);
		default:
			return false;
	}
}
