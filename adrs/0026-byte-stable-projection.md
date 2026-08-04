# ADR-0026: The byte-stable projection contract

- **Status:** Accepted
- **Date:** 2026-08-04
- **Layer:** L2 Kernel (projection)

## Context

ADR-0002 made the event log the single truth: messages are a pure projection
of `seq 0..N`. What 0002 did not pin down was the granularity of that
determinism. The loop rebuilds the message array on every adapter call, so
two projections of the same log MUST agree — but the framework also promises
prompt-cache economics: a model request whose earlier turns are unchanged
must be byte-identical in its prefix, or the provider's cache is worthless.
A projection that is merely "semantically equal" (same content, different
serialization) would silently defeat the cache on every turn.

## Decision

**The same event-stream prefix projects to a BYTE-IDENTICAL message prefix**
(`JSON.stringify`, element for element). New events only ever change the
projection at the tail. The contract is enforced by three regression tests in
`packages/core/tests/prompt-cache.test.ts`: ① the same log projects
identically twice; ② appending a turn leaves the old prefix byte-identical;
③ a microcompact boundary (ADR-0027) replays byte-identically after a JSON
round-trip — the crash + resume shape.

The **sole sanctioned exception** is the persisted `microcompacted` boundary
(ADR-0027): it rewrites OLD tool results in place. It is legal precisely
because the boundary itself is a PERSISTED FACT — replaying the same events
derives the same cleared view, so the exception preserves the contract across
crash/resume rather than breaking it. Every other event kind is append-only
from the projection's point of view.

## Consequences

- The provider prompt cache is a derived property, not a feature: no
  counting API, no cache-control hints in the union, no second copy of
  history to desync.
- Byte stability pins the implementation: the projection must not use
  iteration-order-dependent maps, non-deterministic placeholders, or any
  state that does not come from the log.
- The cost: any future event kind that rewrites history needs the same
  persisted-fact treatment as microcompact — a new boundary event, never an
  in-memory rewrite (ADR-0002's replay principle extended to byte level).

## When to revisit

A second provider whose cache keys on a DIFFERENT serialization (e.g. sorted
keys) would not break the contract — the contract is about OUR stability,
not a provider's canonical form — but would be worth an evaluation of
whether provider-specific canonicalization belongs in the adapter layer.

## Evidence

- Commit `020bc88` (feat(core): MicroCompact — zero-API context relief) —
  the kiso code stage pinned the contract alongside microcompact.
- Tests: `packages/core/tests/prompt-cache.test.ts` (three regression
  tests above); the D 区 byte-discipline sections of the kiso code plan
  (`docs/plans/2026-08-04-kiso-code.md`).
