# ADR-0053: The Projection Admissibility Law — every durable projection consumes the same voided-range semantics

- **Status:** Accepted — recorded at the TV-1C/TT-1 review (2026-08-20),
  on the external reviewer's note, adopted by the integrator after
  verifying the practice already holds uniformly in the tree.
- **Date:** 2026-08-20
- **Layer:** runtime projections (and any future consumer of the durable
  log); zero kernel diff — this ADR names a law, it changes no code.

## Context

The durable log has ONE definition of "never happened": the ranges
`(voidFromSeq, seq]` declared by `model_output_abandoned` markers.
Three independent consumers already honor it, each with its own local
implementation:

- the kernel context projection (`packages/core/src/kernel/project.ts`)
  skips the ranges when deriving messages;
- the recovery derivation (`packages/runtime/src/recovery-plan.ts:219`)
  refuses invocations whose seq lies inside a range;
- the task/evidence projection (`packages/runtime/src/task-assessment.ts`,
  TV-1C) skips the ranges for every consumer — claims admission,
  mutation marking, evidence receipts, precondition proofs.

The risk this ADR closes is not today's code — it is the FOURTH
projection, written later (an experience projection for EX-1, a
learning ledger, any assessment over the log), whose author forgets
the filter. A projection that admits voided events disagrees with
every other reader of the same log about what happened — the exact
class of divergence this codebase exists to make impossible.

## Decision

1. **Every projection over the durable event log MUST consume the
   voided-range semantics before interpreting events**: an event whose
   seq lies inside any `(voidFromSeq, seq]` range of a
   `model_output_abandoned` marker is "never happened" for the
   projection's purposes — not a claim, not evidence, not a mutation,
   not an invocation.
2. **Receipts OUTSIDE the ranges are honest facts** (invariant 7,
   ADR-0052): a precommit-launched execution's receipt that lands
   after the void marker is admissible — the range rule, nothing
   stricter, nothing looser.
3. **The law is about semantics, not representation.** A shared
   helper is NOT mandated; three local implementations of a ten-line
   filter are acceptable. Extraction into a shared utility becomes
   justified only when a real divergence bug or a fourth
   implementation appears — Evidence → Mechanism → Abstraction, in
   that order. What is mandated is the SEMANTICS and a test: a new
   projection ships with at least one voided-range admissibility case
   in its matrix.

## Consequences

- A future projection round (EX-1 and successors) inherits a
  checklist line item, not a framework.
- Reviewers can reject a log-consuming projection that lacks a
  voided-range test without relitigating why.
