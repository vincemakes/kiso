# ADR-0002: The event stream is the single truth — every event carries seq

- **Status:** Accepted
- **Date:** 2026-08-02
- **Layer:** L1 Protocol / L2 Kernel

## Context

Claude Code keeps four copies of the conversation (QueryEngine.mutableMessages,
query State.messages, toolUseContext.messages, disk transcript) synchronized by
hand, with comments warning "these must agree". pi-mono mutates message objects
in place to keep references aliased. Both leak: a restored session silently
diverges from what actually happened.

## Decision

The kernel owns one append-only `EventLog`. Every event carries a monotonically
increasing `seq` assigned at append time. Consumers (surfaces, persistence,
eval, subagents) sync by `seq`; a trajectory is the replay of `seq` 0..N.
There is no mutable message array anywhere — "what happened" is a projection of
the log, never a second copy. Replay, incremental UI, and eval fixtures all
consume the same stream.

## When to revisit

A consumer needs random-access mutation of history (not append). So far every
need has been expressible as "append a new event that supersedes".
