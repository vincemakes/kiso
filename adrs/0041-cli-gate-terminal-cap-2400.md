# ADR-0041: the cli gate's terminal cap — 2400, never raised again

- **Status:** Accepted
- **Date:** 2026-08-05
- **Layer:** apps/cli (governance)

## Context

The cli gate has been raised three times in four rounds: 1200 (v1),
1600 (v2b — the bottom-anchored UI, ADR-0039), 2100 (v2d — the body
renderer, ADR-0040, user-authorized), and now 2400 (v2e — the diff
renderer). Each raise was a budget decision with its own ADR — but a
gate that keeps moving stops being a gate: the next feature round would
simply ask for another number. The v2e round hit the 2100 wall mid-round
(2068/2100, 32 lines of headroom) and the user's ruling made the
terminal decision.

## Decision

1. **2400 is the cli gate's TERMINAL cap** — the fourth and last raise.
   It will never be raised again. The way past 2400 is **structural
   extraction** (e.g., the TUI layer becomes its own package/module
   group) or **scope cuts**, decided by ruling — the gate number is no
   longer a variable.
2. **The counting口径 is fixed**: the gate counts `apps/cli/src/`
   ONLY — tests do not count, docs do not count, the budget stop-and-
   report clause triggers on src increments. (The v2e diff.ts and its
   tests are the first round where the split matters: ~150 src lines
   vs ~120 test lines.)
3. **The raise trajectory is recorded**: 1200 → 1600 (ADR-0039) → 2100
   (ADR-0040) → 2400 (ADR-0041, terminal).

## Consequences

At 2400 the current v2e round has 332 lines of headroom (2068/2400);
the Modes round (~150 src) fits, and a future feel-round (history
up/down, ~30) still fits. Any further feature must fit the remaining
headroom or trigger the extraction ruling — the cap is the forcing
function for the TUI's structural future.

## When to revisit

Never for the number. The extraction path (TUI as a package) is the
revisit trigger: if the TUI grows toward the cap, the ruling decides
the extraction shape — the cap itself stands.

## Evidence

- `scripts/check-size.mjs` (2400), the plan record
  `docs/plans/2026-08-05-tui-v2e.md` (§10), the v2e round commits.
