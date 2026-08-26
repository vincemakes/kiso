# ADR-0005: Retry stays inside the loop — no side-channel state

- **Status:** Accepted
- **Date:** 2026-08-02
- **Layer:** L2 Kernel

## Context

pi-mono's retry promise is created on `agent_end`, gated on
`_lastAssistantMessage`, resolved from a different path than it was created —
an exception path skips `message_end` entirely and the promise never resolves:
`waitForRetry()` hangs forever and only ESC unwedges it. Its error classifier
is one regex over error strings: it misses 529, ECONNREFUSED, and quota codes,
and false-positives on any text containing "500".

## Decision

Two rules, both structural:

1. `StructuredError` is a closed code union (`rate_limit` / `overloaded` /
   `network` / `timeout` / `quota` / `api_5xx` / `context_overflow` /
   `invalid_request` / `unknown`), classified at the adapter boundary. No
   regex over error text anywhere.
2. Retry state (attempts, backoff, budget) lives entirely inside the loop's
   generator frame — the loop retries a `retryable` error by re-entering
   `adapter.stream()` itself, and yields `terminal { kind: 'error' }` when the
   budget is spent. Nothing outside the loop ever resolves or aborts a retry,
   so there is no promise to leak, no side channel to desync, and no race
   with a concurrently-queued user prompt.

## When to revisit

A product needs retry policy that the loop cannot express (e.g. cross-run
retry with session memory). That is harness territory — the loop's contract is
only "retryable errors are retried here, terminal is honest".

## Amendment 1 (2026-08-26, the F4 round): the budget is per-process, and mid-stream retries share it

F4 extends rule 2 to the mid-stream cut: a retryable error arriving
AFTER streaming began settles the attempt, durably voids the draft
(`model_output_abandoned`), and re-enters `adapter.stream()` under the
SAME per-turn `attempts` counter that pre-stream retries use. One
budget bounds total provider re-entries per turn — each mid-stream
retry re-pays its input tokens, so a separate budget would double the
worst case.

Made explicit, because frame state dies with the process: **the budget
is per-process by design.** A crash during backoff (or after the void,
before the re-request) leaves the marker as the last durable boundary;
the resume derives CONTINUE_MODEL and the new process runs a FRESH
in-frame budget. "Bounded requests per turn" therefore holds within one
process lifetime, not across crashes. A durable retry ordinal was
considered and rejected: it would add a durable field to buy a strict
cross-crash bound no observed failure demands — if reality ever
produces a crash-retry loop, that evidence reopens this amendment.
