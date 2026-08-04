# ADR-0027: MicroCompact — context relief as a persisted decision

- **Status:** Accepted (decision #1 superseded in part by 自举 #3, 2026-08-04)
- **Date:** 2026-08-04
- **Layer:** L2 Kernel (compaction)

## Context

The coding agent's context grows without bound: every read, listing, and
shell output stays in the projection forever. The kiso code stage needed
context relief with ZERO API surface — no counting API, no compaction
parameters in the model's view, nothing the harness must re-configure per
model. And ADR-0026 demanded that any history-rewriting mechanism be a
PERSISTED FACT, or the byte-stable contract breaks across crash/resume.

## Decision

MicroCompact is a durable boundary decision, not a per-turn progressive
clearing:

- when the projected context exceeds the threshold, the loop appends ONE
  `microcompacted` boundary event with `beforeSeq`; the projection then
  replaces every eligible OLD tool result (whitelist:
  read_file/list_dir/search_text/shell; never write/edit outputs, never
  `do-not-compact`-tagged results) with a fixed placeholder derived only
  from the stream — `[old tool output cleared: <tool> <arg>]`.
- The boundary is a persisted fact (ADR-0026's sole sanctioned exception):
  replaying the same events derives the same cleared view, byte for byte.

**Generation 1 (commit `020bc88`) drew the boundary by user turns**: the
newest KEEP_RECENT_TURNS user turns stayed intact; everything older was
cleared. **Generation 2 (commit `2648f5f`) superseded it**: 自举 #3 bug#5 —
the coding agent's main overflow shape is ONE user turn that reads many big
files; a single giant turn never crossed the old boundary, so the agent hit
the window with zero relief. The boundary is now drawn by COMPACTABLE-RESULT
RECENTNESS: the newest K = 4 still-visible compactable results stay intact,
whatever turn they belong to; the boundary points at the (K+1)th-newest. A
still-over context appends another boundary at the next iteration — each
boundary makes progress, never a repeated no-op.

## Consequences

- The decision is replayable and auditable: what was cleared, and why, is
  in the log. No compaction state lives outside the events.
- Known cost (generation 1): turn-based boundaries missed single-giant-turn
  sessions — the design was falsified by a REAL workload (dogfood) and
  corrected. The lesson is recorded here, not erased: the arc is part of
  the reasoning.
- Known cost (generation 2): the K = 4 window is a constant tuned by
  observation, not a parameter the harness can tune (the extension
  compaction surface arrived later — see ADR-0028's compaction face).
- MicroCompact is ON by default in the CLI at half the model window
  (`KISO_CONTEXT_WINDOW` override included); library users opt in with
  `microcompact: { thresholdTokens }`.

## When to revisit

A provider with a genuinely different context model (e.g. token-exact
accounting) might justify making the threshold derived rather than
estimated (chars/4); the persisted-boundary mechanism itself is stable.

## Evidence

- Commit `020bc88` (generation 1: user-turn boundary) and `2648f5f`
  (generation 2: compactable-result recentness, 自举 #3 bug#5).
- Tests: `packages/core/tests/microcompact.test.ts` — the single-giant-turn
  trigger (`自举 #3: a SINGLE user turn with 6 big reads triggers`), the
  second-boundary progress test, the byte-identity replay test
  (`the boundary event itself is a persisted fact`).
- E2E: `apps/cli/tests/microcompact-cli.test.ts` (resume over the
  threshold records the boundary and completes).
