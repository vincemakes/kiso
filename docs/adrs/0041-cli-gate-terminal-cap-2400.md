# ADR-0041: the cli gate's terminal cap — 2400, never raised again

- **Status:** SUPERSEDED by ADR-0043 (the TUI extraction — per-package
  gates replace the single 2400 cap), 2026-08-05. Not overturned:
  ADR-0043 EXECUTED this record's own escape hatch — structural
  extraction — so the single cli cap gave way to per-package gates. The
  discipline survives the number and is cited by name in ADR-0043's
  Amendment 3 ("the ADR-0041 discipline").
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
2. **The counting convention is fixed**: the gate counts `apps/cli/src/`
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

## Supersession note (2026-08-18, the SC-1 semantic contract audit)

Appended, never an edit. **This ADR's terminal cap is SUPERSEDED by
ADR-0043**, which says so directly: "the 2400 single-package terminal cap
is superseded by this ruling." Neither this record nor the index
(`docs/adrs/README.md`, which still lists it as plain Accepted) carried
the marker; this note is the append-only form of it.

The superseded promise is the load-bearing one: this ADR called 2400 "the
fourth and last raise", never to be raised again. Per-package gates
replaced the single-package cap; ADR-0043 Amendment 7 then recalibrated
the tui to 4,000, and Amendment 8 made the product-surface figures
report-only — core's 2,000 is the one budget that still blocks.

Residual, NOT fixed in the SC-1 round (outside its fence): live source
still cites this superseded ADR as if current — `packages/tui/src/index.ts`,
`packages/tui/src/status.ts` (which repeats the "never a fifth raise"
promise verbatim), `packages/tui-cells/src/strings.ts`, and the
package-layout sections of `README.md` / `README.zh.md`. Each wants a
forward pointer to ADR-0043.
