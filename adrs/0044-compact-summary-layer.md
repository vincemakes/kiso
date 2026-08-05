# ADR-0044: the context three-layer merge — classic compaction retires into microcompact; /compact adds the model-summary layer

- **Status:** Accepted
- **Date:** 2026-08-06
- **Layer:** core (kernel + protocol) + runtime (session) + cli (the /compact command)

## Context

Context economy had TWO compaction mechanisms with overlapping
responsibilities:

1. **Classic auto-compaction** (`config.compaction`, `compacted` events,
   `microcompact()` in compaction.ts): clears old tool results and persists
   the EXACT replacements as `compacted` events. **Dead code in the
   product** — the CLI never configured it.
2. **The microcompact boundary** (C 区, `config.microcompact`,
   `microcompacted` events): clears the SAME kind of content by persisting
   a boundary fact; the projection re-derives the cleared view
   deterministically — byte-stable across crash/resume.

Both cleared tool results; only one was wired. The live path (2) is
strictly better: its decision is a PERSISTED FACT, so replay derives the
same view without re-running any algorithm. This ruling executes the
merge: the classic path's produce side is deleted, and its responsibilities
are absorbed by the boundary.

The mechanical layer only clears TOOL RESULTS. The second gap: a long
conversation still grows — the model re-reads the whole history every
turn. This round adds the model-summary layer: `/compact` compresses the
older conversation into ONE `summarized` event, and the projection
replaces the covered range with a single assistant summary message.

## Decision

### 1. The mechanical merge

- The loop NO LONGER produces `compacted` events; `config.compaction` is
  **deprecated** (the type stays with a doc note, removed at 1.0) and
  IGNORED. The runtime's `AgentDefinition.compaction` /
  `SessionConfig.compaction` follow the same treatment; the deprecated
  `onPreCompact`/`onPostCompact` hooks stay in the extension contract but
  are never invoked.
- compaction.ts loses its classic produce-side (`microcompact()`,
  `CLEARED_MARKER_PREFIX`, `isClearedMarker`, `shouldClearContent`,
  `KEEP_RECENT_TURNS`, `MicrocompactResult`) — only `estimateTokens`
  remains, shared by the live threshold path.
- **Old logs are forever readable**: `compacted` events in existing
  sessions still LOAD and still REPLAY with their exact v1 (callId-keyed)
  and v2 (eventSeq-keyed) semantics. The projection's `compacted` case and
  the event's schema validation are untouched. This promise is pinned by a
  test: v1 + v2 entries in one log replay verbatim.

### 2. The /compact model-summary layer

- **The event**: `summarized { coversToSeq, summary }`, deep-validated
  into `isKisoEvent` (non-negative safe-int coversToSeq, non-empty
  summary, coversToSeq < seq — a summary covers only what preceded it).
- **The covered range**: from just past the previous `summarized` event's
  coversToSeq (or the trajectory's start) up to `coversToSeq`. The
  boundary is the event BEFORE the K-th most recent user_input (K =
  `KEEP_RECENT_ROUNDS` = 4, a constant), i.e. a TURN BOUNDARY — the
  projection's skip can never split a message.
- **The projection**: covered events are skipped; each summary message
  (ONE assistant message with the summary text) renders AT ITS BOUNDARY —
  the first event after the covered range — so the reading order is
  [summary][recent turns], never the reverse. Byte-stable: a summarized
  event is a persisted fact; the same events derive the same messages on
  every replay, and the summary message round-trips through the seed
  encoder losslessly.
- **The generation**: an OFF-LOOP one-shot call through the SESSION'S OWN
  adapter (no new dependency) with a fixed English prompt constant
  (≤30 lines, kernel-owned). The summary request itself never enters the
  log; a failure throws, nothing is persisted, and the session is
  unchanged — "nothing happened".
- **The original text is never deleted**: the covered events stay on disk
  forever; /last, /think, and the raw log reach them unchanged.
- **Crash semantics**: a crash before the `summarized` event's persist =
  nothing happened; after it, a fresh resume projects the compressed view.
  The kill9 gate gains a variant pinning both states deterministically.

### 3. The CLI command

`/compact` (menu + /help, English description): refused while a turn runs
(a hint to wait — the summary call must never race a run), then runs the
summary and prints ONE NoticeCell with the estimated tokens saved. The
summarized record rides the LAST recorded run's id — a summary fact must
never open a run of its own (the open-run gate keys on terminal-less
runIds). Auto-trigger is explicitly out of scope (a plan candidate for a
real long-session need).

## Consequences

- core 1887 → **1914** / 2000: the mechanical merge net-deleted ~77
  lines; the summary layer added ~104 (event + projection + summarize.ts
  + validator). The merge portion nets DOWN, exactly as the ruling
  intended; the layer itself is new functionality.
- cli 1099 → 1120 / 1320; tui 1264 / 1520 (one menu item + one render
  case).
- 548 tests green (was 533): the summarized projection suite, the
  old-compacted-readability pin, the retirement pin (config.compaction is
  inert, no compacted events, no pre/post hooks), the runtime wiring, the
  CLI PTY + pipe e2e, and the kill9 crash-state variant.
- `compacted` remains in the union forever (the "old events always
  readable" promise); `summarized` is a NEW durable fact family with the
  same discipline: persisted facts, pure projection, byte-stable replay.
- The pipe output is byte-identical to 0.1.19 (regression verified
  against the saved baseline after session-id normalization).
