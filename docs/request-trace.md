# The kiso request trace

The observation ledger (E1, 1.2.0): one durable line per model request,
recording the request's context shape (hashes and thin manifest — never
payloads), its provider-raw usage quartet, its latency, and its outcome,
so that token economics — where fresh tokens are spent, where the cache
attaches, where it breaks — are answerable per request after the fact.
Introduced with the E1 round (2026-08-12) per the R1–R5 adjudications.

## 1. Status: OUT-side, versioned, read API pending

The trace is **OUT-side** (ADR-0051 §6): versionable, never part of the
correctness ABI. R2 (Case B, 2026-08-12): the 1.2.0 export surface is
untouched — the ledger is file-only; a read API into the SDK surface is
deferred to a later round pending the product-line countersign. This
document is the format reference.

**Versioning (R1a).** `schemaVersion` pins BOTH the record shape AND the
hash/fingerprint algorithms (`HASH_SPEC_BY_VERSION` in
`packages/runtime/src/trace/record.ts`). A version bump must pin a spec
for the new version before any writer can use it (`hashSpecFor` throws
otherwise) — "bump the schema" and "re-pin the algorithms" are the same
ritual. Fields are per-round additive: 1.2.0 shipped the locked v1 set
below; E2 (1.3.0) bumped to **schemaVersion 2**, adding the `canonical`
block (the v2 hash spec re-pins the same sha-256 algorithms — the shape
changed, the hashing did not). Both generations are valid reads
(R1d-1): a v1 sidecar has no canonical block and reads as defaults at
every consumer — never a crash. The canonical schema, the pricing
table, and the derivation surfaces are documented in `docs/usage.md`.

## 2. Ledger layout

One ledger per session, a JSONL file of lines:

```
<KISO_HOME>/sessions/traces/<sessionId>.jsonl
```

`traces/` is a sibling of the session files under `sessions/`, and the
session store's enumeration never treats it as a session (R3a, pinned by
a store gate). The file appears only after the first adapter call of the
first run; a run that makes no calls writes nothing.

**Line vocabulary — exactly four kinds**, each carrying `schemaVersion`:

| kind | purpose |
|---|---|
| `header` | written once per file (on first open): session id, kiso version, creation time |
| `request` | one per adapter call — the `TraceRecord` below |
| `run_end` | the run's clean settle: run id, time, `lastRequestIndex` (-1 = the run made no calls) |
| `crash` | written on resume-detected truncation: the previous run died mid-append |

`run_end`/`crash` exist so that a ledger hole (an absent request) is
explainable as a crash rather than as a writer bug — "every request has
exactly one trace" stays checkable.

## 3. The TraceRecord (the field set: v1 = 25, v2 = 26)

The closed field set is pinned bidirectionally by `TRACE_RECORD_FIELDS`
(an added field without the const entry — or a const entry without a
type field — goes red). v2 = the v1 set plus `canonical` (per-round
additive). `lineageLink` and — in v1 — `canonical` are absent rather
than null: a v1 sidecar reads as defaults at every consumer (R1d-1).

| field | type | meaning |
|---|---|---|
| `schemaVersion` | `1` \| `2` | pins shape AND hash algorithms (R1a); v2 re-pins the same sha-256 |
| `kind` | `"request"` | line kind |
| `requestId` | uuid | per adapter call — the reverse-reference anchor |
| `runId` | string | the run this call belongs to |
| `requestIndex` | int ≥ 0 | 0-based ordinal of the call within the run |
| `retryAttempt` | int ≥ 0 | prior calls in this run with an identical `contextHash` |
| `provider` | string | config adapter identity ("openai-compat" \| "anthropic") |
| `model` | string | the model id |
| `adapterVersion` | string \| null | the adapter implementation version (null on failure) |
| `systemPromptHash` | sha-256 hex | the composed system prompt |
| `toolSchemaHash` | sha-256 hex | the tool specs |
| `contextHash` | sha-256 hex | canonical serialization of the full request projection |
| `contextManifest` | segment[] | thin pointers into the event log — §4 |
| `segmentHashes` | sha-256 hex[] | per-segment content hashes, indexed 1:1 with `contextManifest` (the R4b break derivation's analysis-side data — the LIST, not the aggregated fingerprint) |
| `stablePrefixFingerprint` | sha-256 hex | over the cacheable prefix's per-segment hashes — §5 |
| `freshInput` | number | provider-raw usage, never a billing surface (0 = unknown) |
| `cacheRead` | number | provider-raw usage (0 = unknown) |
| `cacheWrite` | number \| null | provider-raw; the openai-compat adapter honestly reports null |
| `output` | number | provider-raw output tokens (0 = unknown) |
| `canonical` | object (v2) | the canonical record of the same quartet — `docs/usage.md` |
| `latencyMs` | number | call → settle, wall clock |
| `ttftMs` | number | call → first yielded adapter event (0 = unknown) |
| `toolCalls` | string[] | tool names invoked, in order |
| `outcome` | `"ok" \| "provider_error" \| "aborted"` | settle classification |
| `lineageLink` | object (optional) | the ADR-0051 §2 B2a quartet: `parentSessionId`, `parentRunId`, `parentInvocationSeq`, `role`; absent when unknown (population is a later enrichment) |
| `ts` | number | `Date.now()` at settle |

The record never copies payloads: `contextManifest` pointers and hashes
stand in for content. **The usage quartet is provider-raw observation —
never a billing surface** (a provider may count a token a dozen ways;
billing must not): openai-compat's `inputTokens` is a TOTAL (fresh =
input − cacheRead); anthropic's `input_tokens` is already fresh-only and
is recorded as-is. The **billing surface is the `canonical` block** (E2):
`canonicalizeUsage` derives `input` as FRESH-ONLY on both routes — the
pinned sentence — and prices it at the versioned table (`docs/usage.md`,
which carries the rates, the freeze date, and the "an approximation, not
a bill" caveat verbatim). Every cost travels with its
`(pricingTableId, pricingTableVersion)` two-tuple stamp (R5b-④b) —
which table, which version — so cross-table version reconciliation and
billing disputes are answerable; `costUsd` may be `null` (R5b-④c), the
explicit-absent stamp when the table has no rate for the route. A
request settling with no usage data records the quartet as zeros with
`cacheWrite` null — "0 = unknown", never faked, and the canonical block
then reads as the zeros' cost.

## 4. The context manifest

One segment per user turn, headed by the system prompt and the tool
schema. Each segment is a THIN pointer:

| field | meaning |
|---|---|
| `role` | `"system" \| "tools" \| "turn" \| "current_turn"` |
| `seqRange` | `[firstSeq, lastSeq]` inclusive of the events that produced the segment; null for system/tools (not events) — and null for every turn when the message count and the log's visible boundaries diverge (an alignment surprise degrades ranges to null: honest thin pointers rather than wrong ones) |
| `estTokens` | estimate (chars/4 per message shape — core's `estimateTokens`) |
| `freshness` | `"fresh" \| "cache_read" \| "cache_write"` — the last turn is `fresh`, everything before it `cache_read` |

Turn boundaries are the log's visible `user_input` events: a **vetoed**
input (replaced with null content — the model never saw it) is not a
boundary; a **rewrite** keeps the original boundary position.

## 5. Hashes and the cache-break derivation (R4b)

- `systemPromptHash` / `toolSchemaHash` / `contextHash` are sha-256 of
  the canonical serialization of the respective projection part. The
  byte discipline: the same construction path produces the same
  serialization (pinned end-to-end by the I6 bytes gate).
- `stablePrefixFingerprint` covers the **cacheable prefix** — every
  segment that is NOT the current turn (freshness `"fresh"` is never
  cacheable). A current-turn change alone never moves it. The
  per-segment hash LIST rides the record (`segmentHashes`, 1:1 with
  `contextManifest` — pinned by the schema validator) — the derivation
  needs the list, not the aggregate.
- The **break count** is an analysis-side derivation (never a recorded
  field): compare two adjacent requests' cacheable-prefix hashes — the
  first differing segment is a break at that depth; a grown prefix
  breaks at the old length; unchanged prefixes are 0 breaks. The
  derivation lives in `packages/runtime/src/trace/analyze.ts`
  (`prefixBreak` / `deriveBreaks`), shared with the bench tooling via
  the built dist.

## 6. Example ledger

```jsonl
{"schemaVersion":2,"kind":"header","sessionId":"s1","kisoVersion":"1.3.0","createdAt":1753400000000}
{"schemaVersion":2,"kind":"request","requestId":"9f3a7c11-…","runId":"run-1","requestIndex":0,"retryAttempt":0,"provider":"openai-compat","model":"m","adapterVersion":"1.3.0","systemPromptHash":"aaaa…","toolSchemaHash":"bbbb…","contextHash":"cccc…","contextManifest":[{"role":"system","seqRange":null,"estTokens":210,"freshness":"cache_read"},{"role":"tools","seqRange":null,"estTokens":88,"freshness":"cache_read"},{"role":"current_turn","seqRange":[1,12],"estTokens":140,"freshness":"fresh"}],"segmentHashes":["aaaa…","bbbb…","cccc…"],"stablePrefixFingerprint":"dddd…","freshInput":41,"cacheRead":12410,"cacheWrite":null,"output":320,"canonical":{"input":41,"cacheRead":12410,"cacheWrite":null,"output":320,"reasoning":null,"costUsd":0.0001908,"pricingTableId":"builtin","pricingTableVersion":1},"latencyMs":2841.5,"ttftMs":402,"toolCalls":["read_file"],"outcome":"ok","ts":17534000002841}
{"schemaVersion":2,"kind":"run_end","runId":"run-1","ts":17534000002842,"lastRequestIndex":0}
```

A 1.2.0 ledger is byte-identical except `schemaVersion:1` and no
`canonical` block — and reads identically at every consumer (R1d-1).

## 7. Lifecycle semantics

- **The tracer sits at the adapter boundary** (kernel, log, and the
  model-visible byte stream are untouched — I6). One record settles per
  call, in the stream's `finally`, so provider errors and aborts settle
  too.
- **Soft-fail**: any failure in trace assembly marks the request ABSENT
  (never breaks the stream); writer I/O degradation downgrades to one
  `console.error` line and drops records. A killed run is detected at
  the next open: the last line is neither `run_end` nor `crash`, so a
  `crash` line is appended and the ledger stays reconcilable.
- **`retryAttempt`** counts prior calls in the run with an identical
  `contextHash` — the kernel's retry loop re-streams the same messages
  array, so an identical hash is exactly "same request, retried".

## 8. Reading the ledger

The file is plain JSONL: parse each line, filter by `kind`. Every line
of a fresh ledger validates against `validateTraceLine` — the
version-dispatching validator accepts both v1 (no canonical block →
defaults) and v2, and the closed set is strict by design (a misspelled
field can never silently enter).
`bench/trace-report.mjs` renders per-request tables from this surface
(E1 slice 5 — a file-only reader, zero exports, per R2 Case B); its
python gate (`bench/tests/test_trace_report.py`) pins the row shape and
the break derivation on synthetic ledgers.
