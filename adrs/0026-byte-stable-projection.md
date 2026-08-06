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

- Commit `8e4ee1b` (feat(core): MicroCompact — zero-API context relief) —
  the kiso code stage pinned the contract alongside microcompact.
- Tests: `packages/core/tests/prompt-cache.test.ts` (three regression
  tests above); the D 区 byte-discipline sections of the kiso code plan
  (`docs/plans/2026-08-04-kiso-code.md`).

## Amendment 1 (2026-08-06): the request-level invariant — where the byte prefix ends

The projection contract covers the MESSAGE ARRAY. The adapter serializes it
inside a request body whose tail (`stream`, `stream_options`, `tools`,
`max_tokens`, …) FOLLOWS the messages array — so the full request bodies
can never be prefix-related: a new message inserts inside `messages`, the
closing `]` shifts right, and the tail re-aligns byte-identically after it.

**The request-level invariant (0.1.23, the fresh-mystery round):** request
N+1 shares request N's bytes through the close of request N's LAST message —
the maximal achievable prefix — and the tails are byte-identical. The
provider's prefix cache is worth exactly that prefix; a byte that changes
ANYWHERE in it (an old message's re-render) silently kills the cache for
the rest of the request, then recovers on the next request.

**The one real violation found and fixed (0.1.23):** the OpenAI-compat
adapter gated `reasoning_content` on the CURRENT turn (C7, the hand-feel
round). At every turn boundary the just-finished turn's assistant messages
LOST the field, re-rendering old history and breaking the prefix at each
boundary (empirically: two breaks in a 14-request real session, both at
turn boundaries; the request after each break showed fresh tokens ≈ the
whole message history). Fix: the field's presence is MONOTONE — once any
message in the projection carries reasoning, every assistant message
carries the field (its own reasoning, or ""); otherwise none does. Flips at
most once per session (at the first thinking, usually turn 1), never again;
real OpenAI never produces reasoning, so its requests are byte-identical to
the pre-0.1.23 behavior. Verified on the real DeepSeek API: the fixed
session's 13 consecutive-request pairs all share the maximal prefix (0
breaks) and every request cache-hits 82-99%, including the turn boundaries
that used to break.

**Debug tooling (kept):** `KISO_DUMP_REQUESTS=<dir>` writes each outgoing
request body to `<dir>/req-<pid>-<n>.json` (real conversation data — never
shared); `bench/dumpdiff.py` byte-diffs consecutive requests and localizes
the first divergence to a JSON path. The diagnosis method of record: dump →
diff → classify (divergence at the last-message end = healthy; inside an
old message = contract violation).
