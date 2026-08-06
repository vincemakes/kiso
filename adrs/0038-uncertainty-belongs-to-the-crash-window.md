# ADR-0038: Uncertainty belongs to the crash window alone; the approval chain guards retries

- **Status:** Accepted (supersedes ADR-0024 in part)
- **Date:** 2026-08-05
- **Layer:** Core (loop, ledger) + runtime (recovery)

## Context

Until this round, a failed execution could be routed into the uncertainty
flow in TWO ways:

1. **The crash window** (ADR-0024's core): an execution that STARTED but
   never reported a result (killed mid-execution) has an unknown outcome —
   the human decides rerun/abandon.
2. **The C group failed-receipt pause**: a tool that FAILED while declaring
   `safeToRetry: false` (i.e., not `idempotent: true`) was treated as
   possibly-side-effected and paused for the same human question — in the
   live loop (kernel/loop.ts) AND, redundantly, in the recovery executor
   (runtime session.ts `#executePersisted`).

The second rule was deliberate and tested (`execution.test.ts` pinned "a
failed NON-idempotent execution PAUSES as uncertain, never a clean
failure"), but the E1 approval chain changed the calculus: **a retry is a
NEW call — it passes the approval chain again**. An ask-tier tool's retry
re-asks the human (deny > ask > allow, ruling A), at a better moment (the
model has the error in hand) and with better context. The failed-receipt
pause became a redundant gate that fired at the WORST time — the real
machine record: a read-only `mcp__fs__directory_tree` failing with ENOENT
(the MCP bridge maps tools without declaring idempotency, so every MCP
failure was `safeToRetry: false`) got its receipt and ✗ result delivered
to the model, and STILL the CLI asked "side effect may have applied?" —
nonsense for a read-only tool.

## Decision (ruling #12, Amendment 1 + Amendment 2)

1. **A complete receipt (succeeded or failed) IS the outcome — such an
   execution is NEVER uncertain.** The C group failed-receipt pause is
   removed from both the live loop and the recovery executor;
   `uncertainExecutions()` reports the crash window only (started, no
   receipt). The ledger's status derivation follows: a failed receipt is
   `"failed"`, never `"uncertain"` (safeToRetry stays on the event for
   history, it no longer feeds status).
2. **Amendment 1 — the honest note**: a non-idempotent failure's result carries
   the line `[non-idempotent tool failed — its side effects may have
   partially applied; verify before retrying]` (live path and recovery
   path identically, receipt and tool_result losslessly). Idempotent
   failures carry no note. The MCP bridge still does not declare
   idempotency — unknown idempotency means the note applies (honest).
3. **Amendment 2 — the CLI's ⚠ line** stays as pure information on replays of
   old logs; the (r)erun/(a)bandon question is gone from it. The human
   question now belongs to exactly one place: the crash window's
   recovery flow.

## Consequences

- The crash window semantics are untouched: started-without-receipt is
  still uncertain, resolved offline through `uncertainExecutions()` /
  `resolveUncertain()`, and the kill -9 gate re-verifies the flow.
- Known cost: a genuinely partial side effect (e.g., a shell command that
  half-ran before failing) no longer gets an automatic human question —
  the model retries with the ✗ output in hand, and the retry re-passes
  the approval chain. The note tells the model to verify first.
- Old logs replay their historical `uncertain_pending` events as
  information only; the ledger now reports their receipted executions as
  "failed" (the resolution events, if any, still read rerun/abandoned).

## When to revisit

A per-tool or per-server idempotency declaration surface (e.g., MCP
config marking a server's tools read-only) would let the note and the
retry guidance be more precise than "unknown = the note applies".

## Evidence

- Commit `52a3672` (fix(core,runtime,cli): ruling #12 — the failed-receipt
  uncertain pause is removed; the note rides non-idempotent failures) —
  see the round's plan (`docs/plans/2026-08-05-round-a.md`).
- Tests: `packages/core/tests/execution.test.ts` (the rewritten C group
  tests — clean failure + note, no pause), `execution-gate.test.ts`
  (siblings run, no channel → recorded failed), `uncertainty-flow.test.ts`
  and `adversarial-race.test.ts` (the offline/crash-window shapes),
  `execution-id-e2e.test.ts` (recovery-path clean failure + note), the
  CLI e2e (approved→failed(fatal) → zero uncertainty questions), the
  kill -9 gate (crash window unchanged).
