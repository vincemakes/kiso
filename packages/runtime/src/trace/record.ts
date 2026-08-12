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
 * correctness ABI. These types are runtime-internal (Case B of R2 — the
 * export surface stays untouched pending the product-line countersign).
 */

/** schemaVersion: 1 for 1.2.0. Algorithm and shape changes bump it
 *  (ADR-0051 §6 OUT-side versioning). */
export const TRACE_SCHEMA_VERSION = 1;

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
	schemaVersion: 1;
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
	stablePrefixFingerprint: string; // sha-256 over the per-segment hashes of the cacheable prefix (see §4)
	freshInput: number; // provider-raw usage, never normalized — normalization is E2's
	cacheRead: number;
	cacheWrite: number | null; // openai-compat honestly reports null; anthropic reports real
	output: number;
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
	ts: number; // Date.now() at settle — added to the work-order field list (justification §1.5)
}
/** That is the complete set for 1.2.0. */

// ── Ledger kinds (proposal §1.2 — the file's line vocabulary) ────────────
// Exactly four kinds, each carrying schemaVersion. run_end/crash exist so
// that a ledger hole (an ABSENT request) is explainable as a crash rather
// than as a writer bug — "every request has exactly one trace" stays
// checkable.

export interface HeaderLine {
	schemaVersion: 1;
	kind: "header";
	sessionId: string;
	kisoVersion: string;
	createdAt: number;
}

export interface RunEndLine {
	schemaVersion: 1;
	kind: "run_end";
	runId: string;
	ts: number;
	lastRequestIndex: number;
}

export interface CrashLine {
	schemaVersion: 1;
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
};

export function hashSpecFor(version: number): HashSpec {
	const spec = HASH_SPEC_BY_VERSION[version];
	if (spec === undefined) throw new Error(`no hash spec pinned for trace schemaVersion ${version}`);
	return spec;
}

// ── The closed-field-set gate (R1a) ───────────────────────────────────────
// Trace-schema.test.ts asserts Object.keys of a fully populated record is
// EXACTLY this set (both directions).

export const TRACE_RECORD_FIELDS = [
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
	if (!isRecord(v) || !hasClosedKeys(v, TRACE_RECORD_FIELDS, ["lineageLink"])) return false;
	if (v.schemaVersion !== TRACE_SCHEMA_VERSION) return false;
	if (v.kind !== "request") return false;
	if (typeof v.requestId !== "string" || typeof v.runId !== "string") return false;
	if (!isNonNegInt(v.requestIndex) || !isNonNegInt(v.retryAttempt)) return false;
	if (typeof v.provider !== "string" || typeof v.model !== "string") return false;
	if (v.adapterVersion !== null && typeof v.adapterVersion !== "string") return false;
	if (!isHex64(v.systemPromptHash) || !isHex64(v.toolSchemaHash) || !isHex64(v.contextHash)) return false;
	if (!isHex64(v.stablePrefixFingerprint)) return false;
	if (!Array.isArray(v.contextManifest) || !v.contextManifest.every(validateTraceSegment)) return false;
	if (!isNumber(v.freshInput) || !isNumber(v.cacheRead)) return false;
	if (v.cacheWrite !== null && !isNumber(v.cacheWrite)) return false;
	if (!isNumber(v.output) || !isNumber(v.latencyMs)) return false;
	if (v.ttftMs !== null && !isNumber(v.ttftMs)) return false;
	if (!Array.isArray(v.toolCalls) || !v.toolCalls.every((t) => typeof t === "string")) return false;
	if (typeof v.outcome !== "string" || !VALID_OUTCOMES.has(v.outcome)) return false;
	if (v.lineageLink !== undefined) {
		const l = v.lineageLink;
		if (!isRecord(l)) return false;
		if (typeof l.parentSessionId !== "string" || typeof l.parentRunId !== "string") return false;
		if (!isNonNegInt(l.parentInvocationSeq)) return false;
		if (typeof l.role !== "string") return false;
	}
	if (!isNumber(v.ts)) return false;
	return true;
}

export function validateTraceLine(v: unknown): v is TraceLine {
	if (!isRecord(v)) return false;
	if (v.schemaVersion !== TRACE_SCHEMA_VERSION) return false;
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
				isNonNegInt(v.lastRequestIndex)
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
