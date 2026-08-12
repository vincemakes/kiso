# ADR-0048: Recovery as a pure projection — the plan, the thin driver, the EffectGate

- **Status:** Accepted
- **Date:** 2026-08-11
- **Layer:** packages/runtime (recovery)

## Context

Recovery grew one bespoke branch per gap: Gap A (the committed turn
with an invisible invocation), Gap B (the tail draft), the straddle
(Amendment 1's three sentences), the α row (Amendment 2). Each gap
added a conditional to `#recover`, and each live shape (dogfood-0143,
review-0143) had to be re-derived by hand. The R-F 0.1.46 directive:
make the recovery decision a pure function of the durable prefix, and
let the driver converge to a loop over it.

The durability question stays the same: the log stops at ANY byte —
what is the ONE safe next step? ADR-0047 defined prefix-complete
execution (never zero, never two) and the durable-decision law. This
ADR moves the mechanism: the decision is a PROJECTION, not a state
machine.

## Decision

1. **The recovery plan is a pure projection.** `deriveRecoveryPlan(
   events, scope)` computes the one safe next step: no I/O, no ID
   generation, no clocks — the same prefix always derives the same
   action. The derivation order is fixed: TERMINAL → COMPLETED →
   RESOLVE_UNCERTAIN (the ledger's insertion order; only the
   started-no-receipt window — the crash window, the human's) → Gap B
   ABANDON_DRAFT → the Gap A invocations (scope order, the turnStop
   clause, the hasRequest/hasExecution/hasResult/decidedBy clauses) →
   the stored requests (scope then log tail; voided-skip; decidedFor-
   request by decisionId — E1) → the receipt repairs (executionId-
   keyed) → the resolution fills → CONTINUE_MODEL.

2. **The driver converges to a loop over the projection.** `#recover`
   is thin: derive → append the derived step → re-derive — a loop over
   the plan, never a second state machine. The driver's OWN decision
   write stamps `decidedBy: "mode:default"` when the verdict carries
   none: the plan binds a call only by a decidedBy-carrying decision
   (E1), so an unstamped driver write would re-derive DECIDE_PERMISSION
   forever — the plan cannot tell the driver's write from a human's.
   A HUMAN verdict binds its request by decisionId, never the call.

3. **The pause-vs-draft boundary — an AMENDMENT to Amendment 1's
   sentence 3, not a classification clarification.** Gap B voids a
   text-bearing no-stop suffix — but a suffix after a `user_input`
   boundary that carries a pending `permission_requested` is the
   approval-panel pause, never a draft: the call was extracted and
   asked, the request is durable, WAIT_PERMISSION re-announces it.
   (The loop persists the stream's tail AFTER the pause resolves, so a
   crash mid-pause leaves exactly this shape.) The liveAsk rule is a
   FIX to the pinned sentence — an exemption: "a suffix whose pending
   ask the human answers is committed by the durable verdict and the
   closed pair — human ratification outranks the missing stop." In the
   0146-a dogfood the turn's text+call+result never earned its own
   stop, yet after the human approved and the pair closed it projected
   as committed history: a durable human verdict outranks a protocol
   marker. A request AFTER a stop keeps the 0143 shape: the marker
   voids it and it expires with the draft (ADR-0047 Amendment 1
   sentence 3) — never re-presented, never executed.
   **Boundary asymmetry (an OPEN 1.0 line)**: a pending ask after a
   `stop` boundary dies (0146-b v3b: abandon + expiry + re-ask), a
   pending ask after a `user_input` boundary lives (re-presentation) —
   the same human-facing moment, a different outcome decided by a
   boundary detail the human never sees. The 1.0 Durable Execution
   Contract round unifies this (candidate: any pending ask is
   re-presented, partially superseding sentence 3's expiry) or argues
   the asymmetry.

   **CLOSED — the 0.1.49 Durable Execution Contract round (ADR-0051 §8,
   ruling R9, 2026-08-12).** The asymmetry closes as a semantic-axis
   unification: the contract sentence — "a pending ask lives iff its
   invocation is not voided and the derivation can still execute it."
   A `user_input` boundary commits the suffix to continuation (the
   liveAsk exemption, ADR-0047 Amendment 2); a `stop` boundary closes
   the turn and the draft's undecided asks die with it. The candidate
   (any pending ask re-presents) was rejected — it would repeal the
   voided-request-expiry limb, reopen the R-E straddle adjudication,
   and re-present asks whose invocations are voided (approving a ghost
   call the contract forbids to execute). Zero code; the gates are
   untouched.

4. **The EffectGate and the crash matrix.** The deterministic
   complement to the OS-layer SIGKILL e2e (scripts/demo-kill9.sh): a
   TEST-ONLY gate at the four effect boundaries (persist / model /
   tool / human) with park(point) arming a hold on the NEXT effect —
   the held promise IS the crash point; the durable state is everything
   BEFORE the held boundary. The matrix (crash-before AND crash-after
   each boundary → reopen → derive over the prefix → continue to the
   terminal; the repair-write rows crash the recovery's OWN appends —
   the reopen derives the SAME action and the repair lands exactly
   once) is permanent in `npm run check`.

## Consequences

- The R-E prefix-table gate (16 rows) and the healing fixtures (the
  three poisoned real jsonls, byte-identical) gate the plan unchanged —
  zero-deviation, zero-change green; the full runtime suite is 229/229.
- A new gap is now a row in the matrix and/or the plan's order, not a
  new branch in the driver.
- The crash semantics in the matrix: a process death at the held
  boundary is a DROP, not `it.return()` — the generator blocks INSIDE
  the held effect's await, so return() queues behind the hold and
  hangs; a real SIGKILL waits for nothing.
