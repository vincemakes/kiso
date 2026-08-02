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
