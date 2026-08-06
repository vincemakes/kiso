# The context three-layer round — the mechanical merge + the /compact model-summary layer (0.1.20)

2026-08-06. Spec: "the context three-layer round: the mechanical merge + the /compact model-summary layer, release 0.1.20. The reporting discipline as usual."

## 1. the mechanical merge (ADR-0044, executed)

The classic auto-compaction (`config.compaction` / `compacted` events /
`microcompact()` in compaction.ts) was dead code — the CLI never
configured it. microcompact absorbed its responsibilities:

- loop.ts: the classic block deleted; `config.compaction` deprecated
  (type kept, doc note, removed at 1.0) and IGNORED. Same treatment for
  runtime `AgentDefinition.compaction` / `SessionConfig.compaction` and
  the `onPreCompact`/`onPostCompact` hooks (types stay, never invoked).
- compaction.ts: the classic produce-side deleted (`microcompact()`,
  `CLEARED_MARKER_PREFIX`, `isClearedMarker`, `shouldClearContent`,
  `KEEP_RECENT_TURNS`, `MicrocompactResult`); `estimateTokens` stays.
- **Old logs are forever readable**: `compacted` events still load and
  replay verbatim (v1 callId-keyed + v2 eventSeq-keyed); the projection
  case and the schema validation untouched. Pinned by a test.
- **Core budget nets DOWN on the merge portion**: the deletions were ~77
  lines; the summary layer added ~104 → core 1887 → 1914/2000.

## 2. The /compact model-summary layer

- **Event** `summarized { coversToSeq, summary }` — deep-validated
  (safe-int coversToSeq, non-empty summary, coversToSeq < seq).
- **Covered range**: (previous coversToSeq, coversToSeq]; the boundary =
  the event before the K-th most recent user_input (K =
  `KEEP_RECENT_ROUNDS` = 4, constant) — a TURN BOUNDARY by construction.
- **Projection**: covered events skipped; ONE assistant summary message
  renders AT THE BOUNDARY (the first event after the range) — reading
  order [summary][recent], byte-stable, lossless round-trip. This ordering
  was a design catch: the summarized event sits at the log's END (the
  kept rounds live between the boundary and it), so rendering at the event
  would put the summary AFTER the recent conversation.
- **Generation**: off-loop one-shot through the session's OWN adapter,
  fixed English prompt constant (≤30 lines). Failure = honest error,
  nothing persisted. Original events stay on disk forever.
- **Crash semantics**: pre-persist crash = nothing happened; post-persist
  = resume projects the compressed view (kill9 variant pins both).
- **Runtime wiring catch**: the summarized record must ride the LAST
  recorded run's id — a "compact" runId would leave the session "with an
  open run" and block the next run() (the open-run gate keys on
  terminal-less runIds).

## 3. CLI /compact

Menu + /help entry (English); refused mid-run ("wait for it to finish" —
the summary call must never race a run); ONE NoticeCell with the
estimated tokens saved. Auto-trigger NOT in this round — a plan candidate
for a real long-session need.

## 4. Acceptance

- **548 tests green** (was 533): summarized projection (replacement /
  byte-stable / round-trip / two-summary ordering / crash-shape),
  old-compacted readability, the retirement pin (config.compaction inert,
  no compacted events, no hooks), event-schema cases, runtime wiring
  (persist + reload + failure-leaves-unchanged + second-summarize), CLI
  PTY e2e (mid-run refusal + success + ctx drop + durable event), pipe
  e2e (zero ANSI), kill9 crash-state variant, the rewritten
  compaction-regrowth fixture (the regrowth lesson is now structural).
- **Pipe regression**: `hello` pipe run vs the 0.1.19 baseline —
  BYTE-IDENTICAL after session-id normalization.
- Gates: core 1914/2000 · cli 1120/1320 · tui 1264/1520.

## 5. Test-writing notes (for future PTY rounds)

- The PTY driver's needle must key on a signal UNIQUE to the intended
  moment: "you> " matches the dock's initial render AND every prompt;
  "working" matches the recovery's leftover status. The mid-run feed keys
  on the go turn's own shell cell ("sleep 4"), the post-run feed on the
  recap ("1 tool").
- The seeded session's recovery resume consumes a script turn — the
  sliced script must lead with the recovery's end_turn, not the first
  live-turn turn (fauxSkip = the seed's result count).
- A /compact fed while the line-handler is mid-recovery is QUEUED, not
  refused (replReady false) — the refusal only fires when currentRun is
  set.

## 6. Post-publish notes (0.1.20, eight packages)

- Registry: all eight @vincemakes/kiso-* at 0.1.20 (direct curl, all
  present immediately — no metadata lag this round).
- Fresh-install smoke: tier D nested tarballs — "added 8 packages" (the
  kiso-tui tarball nested before the CLI); smoke PASS across all five
  consumer tiers on packed artifacts.
- Three bare runs of the installed CLI (exit 0): ~ (real extensions load:
  mcp/skills/subagent/safe-defaults), /, and an empty non-git dir.
- Published-artifact idle probes: long + short scenarios, 8s idle each —
  649B (<2KB), the round's response exactly once, zero LF, no dangling
  CSI.
- Published-artifact /compact smoke: seeded 7-round session +
  `/compact` → "saved ~1,637 tokens", exit 0.
