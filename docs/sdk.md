# The kiso SDK

The public SDK surface of kiso — what `@vincemakes/kiso-runtime` exports at
its root, what that contract means, and what deliberately lives behind the
first-party door. Adjudicated for the S1 round (2026-08-12); every name in
the manifest is review-signed and pinned by the surface gate
(`scripts/api-surface.mjs --check`), so the table below cannot silently
drift.

## 1. The root manifest (37 names, pinned by the gate)

The curated three-column manifest. `keep` = the SDK surface; `alias` =
deprecated old names, additive until the next major; `internal` = the
machinery the SDK deliberately does not expose (see §3).

| Name | Column | Notes |
|---|---|---|
| `Agent` | keep (canonical) | the canonical name for the runtime class |
| `Session` | keep (canonical) | the canonical name for a session |
| `AgentRuntime` | keep, deprecated alias | `@deprecated` — the canonical name is `Agent` (removed next major) |
| `AgentSession` | keep, deprecated alias | `@deprecated` — the canonical name is `Session` (removed next major) |
| `createAgent`, `AgentDefinition` | keep | the agent factory and its config |
| `Run` | keep | the run handle (`abort()`, async iterable of `Event`) |
| `SessionStore`, `StoreRecord`, `SessionMeta`, `StaleWriterError`, `StoreCorruptionError` | keep | the append-only JSONL store |
| `PoisonedSessionError`, `ResumeBlockedError` | keep | the two documented session failure modes |
| `ApprovalRequest`, `CompactInfo`, `SessionConfig`, `SummarizeResult` | keep | session-level types |
| `Event` | keep | the durable event union (§2) |
| `disposeExtensions`, `loadExtensions`, `loadProjectExtensions`, `KisoExtension` | keep | the extension contract |
| `executionLedger`, `executionForCallId`, `ExecutionRecord`, `ExecutionStatus` | keep | the durable execution ledger |
| `kisoHome`, `projectArtifacts`, `recordTrust`, `trustFor`, `TrustRecord`, `TrustDecision`, `ProjectArtifact`, `ProjectArtifacts` | keep | trust decisions, durable |
| `PermissionPolicy`, `PermissionRule` | keep | the permission gate config |

Adjudication detail (review rulings, 2026-08-12): `ledger` and `trust`
stayed **public**; `lock-adapter`, `recovery`, `compose`, `summarize`, and
`buildAdapter` moved **internal**.

## 2. The Event Stream Contract

> **durable observation ≠ committed conversational history**

Every event in the union is durable (persist-first: written to the JSONL
store before it is yielded by `Run`; there is no ephemeral plane). But only
some events become committed *history*. The table is the contract.

### 2.1 The contract sentences

- **persist-first, no ephemeral plane** — every event is written to the
  JSONL store before it is yielded by `Run`; there is no ephemeral event
  stream.
- **drafts are durable observations** — `text_delta` / `thinking` /
  `tool_call_*` are persisted like everything else; they become committed
  history only when a committed boundary closes them (stop / user_input /
  terminal / compaction / summarized).
- **crash before a boundary** → the kernel writes `model_output_abandoned`
  on resume; the projection voids `(voidFromSeq, marker.seq]` — **model
  output only** (the R-E 0.1.44 void scope sentence: text_delta / thinking /
  tool_call_start / tool_call_input_delta / tool_call_end); framework facts
  never void (permission*, tool_execution*, tool_result, user_input,
  terminal).
- future UI-only signals (spinner / TTFT / elapsed) must be a NEW type
  (LiveUpdate / RuntimeSignal) — never a new Event variant, never in the
  frozen union.

### 2.2 The table (27 variants; stability is derived, not chosen — ADR-0051 §1 puts every variant in the forever-ABI)

| Event | projection role | stability | notes |
|---|---|---|---|
| assistant_start | committed/projecting (explicit message boundary; empty messages preserved) | frozen | |
| assistant_end | committed/projecting (closes the explicit message) | frozen | |
| text_start | committed/projecting (block boundary) | frozen | |
| text_delta | **draft observation** (voidable) | frozen | |
| text_end | committed/projecting (block boundary) | frozen | |
| tool_call_start | **draft observation** (voidable; provenance boundary) | frozen | |
| tool_call_input_delta | **draft observation** (voidable) | frozen | |
| tool_call_end | **draft observation** (voidable; projects a tool_use block when committed) | frozen | |
| tool_result | committed/projecting (renders a tool message; pair-atomicity) | frozen | |
| user_input | committed/projecting (renders a user message; may be replaced/vetoed by user_input_replaced) | frozen | |
| thinking | **draft observation** (voidable; accumulates into the assistant's reasoning) | frozen | |
| usage | control fact (renders nothing; token accounting) | frozen | |
| stop | control fact (turn boundary; renders nothing) | frozen | |
| terminal | control fact (renders nothing; the one terminal per run) | frozen | |
| compacted | control fact (replaces covered results in place; renders nothing itself) | frozen · **deprecate-with-upgrade** (ADR-0051 §1: never-writable by 1.0+ bins) | |
| microcompacted | control fact (replaces eligible results in place) | frozen | |
| summarized | control fact **with rendering payload** (its summary message renders at the boundary position — the one control fact that produces content) | frozen | |
| tool_execution_started | control fact (durable side-effect start) | frozen | |
| tool_execution_succeeded | control fact (durable receipt) | frozen | |
| tool_execution_failed | control fact (durable receipt) | frozen | |
| tool_execution_resolved | control fact (human verdict) | frozen | |
| permission_requested | control fact (durable ask) | frozen | |
| permission_decided | control fact (durable answer) | frozen | |
| permission_expired | control fact (durable close) | frozen | |
| uncertain_pending | control fact (durable pause marker) | frozen | |
| user_input_replaced | **flag:** control fact (a veto/rewrite decision; its payload renders at the replaced input's position) | frozen | |
| model_output_abandoned | control fact (the void marker; renders nothing, skips itself) | frozen | |

Totals: **5 draft observation · 6 committed/projecting · 16 control fact**.
Stability: **27/27 frozen** — stable/evolvable are reserved for the future
non-durable surface (LiveUpdate / RuntimeSignal), which is outside this
union by construction.

### 2.3 What a consumer does with this

- **Render** the committed/projecting rows and — while streaming — the
  draft observations that precede their boundary (text_delta / thinking
  stream in live).
- **Ignore** the control facts, except `summarized` (render its payload at
  the boundary position) and `user_input_replaced` (render its payload at
  the replaced input's position).
- **Know what the void does**: a `model_output_abandoned` marker means the
  draft suffix `(voidFromSeq, seq]` was never committed — model output
  only, framework facts survive. A tool call inside a voided range was
  never executed (and never will be).

## 3. `./internal` — the first-party door

`@vincemakes/kiso-runtime/internal` exports today's pre-S1 root verbatim —
`recovery`, `compose`, `summarize`, `lock-adapter`, `buildAdapter`, and the
rest. It exists for the in-repo consumers (the CLI, the extensions, the
tests). **It is NOT part of the public SDK contract**: unstable — anything
there can move or vanish in any release without a major bump. External
consumers must import the curated root.

## 4. Canonical names

`Agent` = `AgentRuntime`, `Session` = `AgentSession` — additive aliases
introduced in 1.1.0 (ADR-0051 Amendment 1: release rounds move the cli
minor). The old names carry `@deprecated` JSDoc and are removed in the next
major. Existing code keeps compiling; new code should use the canonical
names.
