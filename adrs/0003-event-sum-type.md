# ADR-0003: The event stream is a discriminated union, not a dict

- **Status:** Accepted
- **Date:** 2026-08-02
- **Layer:** L1 Protocol

## Context

A loose `{type: string, ...unknown}` event defers every misuse to production —
a consumer reads `.text` on an event that has none, and the bug surfaces as a
blank UI three releases later. mauri's ADR-0003 (the Python original) chose a
dataclass union for the same reason. pi's packages/ai reached the identical
shape independently — two implementations, one answer.

## Decision

`Event` is a discriminated union on `type`, and `Message` on `role`. With
`strictNullChecks` on, an unhandled variant is a compile error at the `switch`
— the exact moment you want to be interrupted. Provider-private fields
(thinking blocks, cache_control, reasoning_content) never enter the union;
adapters digest them. A new event variant breaks every consumer that forgot it,
by construction.

## When to revisit

A consumer needs to extend events without touching the kernel — that's what
hooks (L2) are for; events stay closed.
