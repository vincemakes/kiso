# ADR-0022: Reliable Session Alpha — the first vertical slice

- **Status:** Accepted
- **Date:** 2026-08-03
- **Layer:** Cross-cutting

## Context

ADR-0021 (2026-08-03) ruled that kiso is a complete framework on a small
core: the core stays a kernel under a 2,000-line gate, the framework grows in
packages, and ADR-0001's "microkernel only" stance is superseded (the old
ADRs are kept — decision history is the point of the discipline). What 0021
did not decide: what to BUILD first, and who consumes the framework.

The core prototype (1,152 lines, 43 tests, 6 incident fixtures) has never
been exercised by a real product-shaped consumer. A framework with no
consumer accumulates unvalidated contracts. The direction ruling names the
reference product: a coding-agent CLI that dogfoods kiso.

## Decision

kiso ships its first vertical slice — **Reliable Session Alpha** — with the
coding-agent CLI as reference product, per `docs/plans/2026-08-03-reliable-session-alpha.md`:

1. **API is not frozen.** The 1,152 lines are a core prototype. The slice
   may reshape contracts where tests and code facts justify it; each reshape
   is a normal ADR-annotated change, not a regime change.
2. **The slice is the acceptance.** Nine user outcomes (install → create
   agent in ~20 lines → multi-turn CLI chat → coding tools → approvals →
   pause → cross-process resume → exactly-once side effects → replayable
   trajectory). A demo passing is not the slice passing.
3. **Durability is a first-class contract.** Events are written to an
   append-only JSONL store before being published; session state is a pure
   projection of that log; the 2,000-line gate constrains only
   `packages/core`.
4. **The 2,000-line limit applies to core only** (reaffirming 0021). The
   framework has no line budget. Core stays small because it must — not
   because everything must.
5. **Boundaries of this slice** (unchanged by later growth): no publish, no
   memory/RAG/scheduler/workflow, no "continuous learning" claims, no empty
   packages, oohki/uooki/mauri/pi/CC are read-only references.

## Consequences

- Workspace monorepo (packages/core, runtime, providers, tools-node, evals;
  apps/cli). Adapters and eval move out of core; core gains `ajv` as its
  single runtime dependency for real JSON Schema validation of tool args
  (ADR-0023 records it).
- `defer` stops pretending to be a deny: approvals become durable pauses
  with a persisted decision record and same-run resume.
- Tool side effects get an execution ledger (`started`/`succeeded`/`failed`);
  interrupted executions are `uncertain` and require a human decision; a
  confirmed-successful side effect never re-runs.
- Provider stop reasons map to explicit terminal kinds; a turn that has
  already emitted content is never silently re-streamed.
- CLI (`kiso chat|resume|sessions`) is the reference product; faux mode runs
  keyless, real providers run on API keys.

## When to revisit

The slice is complete and a second product arrives: revisit the "one
reference product" stance (a second consumer may legitimize pulling shared
capability down into core — 0021's 2+ products rule). Also revisit when a
session's JSONL volume makes write-ahead fsync a measured bottleneck: batch
fsync with a durability budget is the escape hatch, with a fixture pinning
the crash window.
