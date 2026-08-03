# ADR-0025: executionId identity, crash-safe storage, and real cross-process resume

- **Status:** Accepted (supersedes ADR-0024 in part)
- **Date:** 2026-08-03
- **Layer:** L2 Kernel / L3 Tool / runtime / tools / providers

## Context

The Reliable Session Alpha hardening round (Areas 1-6) proved four
assumptions of ADR-0024 wrong under adversarial review:

1. **The (name, input) dedup guard swallowed legitimate repeats.** A user
   intentionally running the same shell command twice — or the model
   re-issuing an identical read after a transient failure — was silently
   replayed or blocked. Exactly-once cannot be keyed on "what the call
   looked like"; it must be keyed on "which execution this is".
2. **`approve()` after a restart only wrote a decision; it did not resume
   anything.** A pause was a durable request without a durable continuation —
   "cross-process resume" was a claim, not a state machine.
3. **Storage trusted the file.** A torn tail glued new JSON onto a fragment;
   mid-file corruption and seq gaps were silently read as prefixes; two
   processes could append to one session; an EventLog could be seeded with
   duplicate seqs masked by array length.
4. **Failures of non-idempotent tools were treated as "no side effect".**
   A throw, timeout, abort, or non-zero exit after a side effect began was
   recorded as a clean failure and freely re-run.

## Decision

1. **`executionId` is the identity of a logical execution** (Area 3): a
   framework-generated id, unique per log (`ex-<seq>`), written on every
   `tool_execution_started` and carried through `succeeded`/`failed`/
   `resolved`. The provider `callId` is correlation only and may repeat.
   The (name, input) guard is REMOVED (ADR-0024 decision #2 superseded): a
   new logical call with identical parameters executes normally. Exactly-once
   is enforced by receipt repair (2) and human decisions on uncertain
   executions (3).

2. **Receipt repair** (Area 2): a `tool_execution_succeeded`/`failed` whose
   `tool_result` never landed is completed FROM THE RECEIPT on the next
   resume/run — the side effect is never re-executed to regenerate a lost
   message.

3. **Failure semantics** (Area 3): a failed execution is `uncertain` unless
   the tool PROVED safe-to-retry (`idempotent: true`, carried as
   `tool_execution_failed.safeToRetry`). Uncertain executions block
   `resume()` (`ResumeBlockedError`) until a human resolves each —
   "rerun" (the side effect may run again) or "abandoned" (a recorded
   denial is filled so the model is never left staring at an unanswered
   call). No automatic re-run of anything that may have had a side effect.

4. **The pause is a durable state machine** (Area 2): `permission_requested`
   carries the full call (callId/name/input). `session.resume()` continues
   the INTERRUPTED run — it adopts the original runId, applies every
   durable decision (executing the persisted call or writing the denial
   result — never re-asking the model, never a second approval), fills
   receipts, and drives the original trajectory to its terminal. A
   decision made while no process ran is applied on resume without
   pausing again. `approve()` resolves into the live run's frame; the
   run's own frame (loop or recovery) writes `permission_decided` — one
   writer per event, no seq duplicates; with no live run it persists
   directly.

5. **Storage is crash-safe** (Area 1): append is write-ahead (fsync before
   publish) under an O_EXCL `<session>.lock` cross-process single-writer
   lock (dead-pid locks are taken over). A torn tail (file not ending in a
   newline) is truncated to the last complete line under the lock before
   the next append. `load` is strict: a partial FINAL line is the only
   tolerated damage; mid-file garbage, valid-JSON-but-not-a-record lines,
   and seq discontinuities throw `StoreCorruptionError`. EventLog seeding
   validates `seq === 0..N`. One `AgentSession` runs at most one active
   run. fds/locks are released by `close()`; directories are fsynced.

6. **Cancellation is one signal everywhere** (Area 4): the retry backoff,
   the approval wait, every pending tool (sibling guard), and the SDK
   calls all observe the same signal; an SDK user-cancel maps to an
   `aborted` terminal, never a generic error. `shell` kills its whole
   process tree on timeout/abort.

7. **Honest terminals** (Area 6): missing stop, duplicate stop, and
   tool_use-without-a-call are structured error terminals; provider stop
   reasons map exhaustively (refusal/pause_turn/content_filter/
   context_window/function_call are never `completed`); usage is
   `known: false` with nulls when the provider reports none.

## Consequences

- The event union grew (`executionId` fields, `safeToRetry`, source/tags on
  message events, new stop reasons) — exhaustive switches find every
  consumer.
- `tools-node` tools are bound to a workspace root with canonical path
  enforcement (Area 5); the CLI's approval prompt never truncates
  security-critical parameters.
- The runtime's `resume()` is the CLI's recovery flow; a new prompt is a
  separate, explicit step.

## Known residuals (adversarial review, 2026-08-03)

- **PID reuse can wedge a session lock**: a crashed writer's `.lock` holds
  a pid the OS later reuses for an unrelated live process → the lock looks
  alive forever. A time-based staleness fallback would break legitimate
  long-lived writers, so this stays; the error message names the pid.
- **Path TOCTOU**: `resolveWithinRoot` canonicalizes, then the filesystem
  is touched separately; a concurrent attacker swapping a verified
  directory for a symlink in the window can land a write outside the
  workspace. Post-write re-checks report the escape (the write itself
  cannot be undone). All non-concurrent escape scenarios are refused.
- The stale-lock takeover race (two processes recovering one crash) is
  tolerated: the loser retries instead of dying.

## When to revisit

- The `ex-<seq>` executionId scheme: if trajectories from multiple sessions
  ever merge into one log, ids need a session component.
- Receipt repair's O(n) scan per resume: revisit when session logs grow
  large enough to matter.
- Parallel tool execution: sequential by design (ADR-0024); restore
  windowed batching only with per-call ledger ordering preserved.
