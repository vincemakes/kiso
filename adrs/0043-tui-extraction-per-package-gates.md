# ADR-0043: the TUI extraction — the terminal layer becomes packages/tui; per-package gates replace the single 2400 cap

- **Status:** Accepted
- **Date:** 2026-08-05
- **Layer:** governance (the cli gate, ADR-0041) + packages/tui (new)

## Context

ADR-0041 set 2400 as the cli gate's TERMINAL cap with one escape hatch:
**structural extraction** — "the way past 2400 is structural extraction
or scope cuts, decided by ruling — the gate number is no longer a
variable." The TUI v3 round (banner/user block/recap/dock/menu/glyphs)
brought the cli to 2325/2400 with the feel-rounds still queued. This
ruling executes the escape hatch: the terminal layer — the cell
renderer (body), the dock, the raw editor, the diff renderer, the
palette and width tables — leaves the cli for a new package,
`packages/tui` (`@vincemakes/kiso-tui`).

## Decision

1. **The terminal layer is a new package** with ZERO runtime
   dependencies: input is data, output is bytes. The only cross-package
   runtime reference (the approval detail's canonical-path resolver,
   `@vincemakes/kiso-tools-node`) becomes an INJECTED resolver — the
   cli passes the tools' own resolution; the tui package stays pure.
   The cli keeps the policy chain (mode.ts), the approval flow, the
   command dispatch, and the session wiring.
2. **Per-package gates replace the single cap** (measured after the
   extraction, actual + 20%): cli 2400 → **1320** (actual 1099), tui
   gains **1520** (actual 1261). The core gate stays 2000.
3. **The sum of the two gates may exceed 2400** — this is the explicit
   point of extraction, not an evasion: the layering's breathing room
   is the legitimate yield of splitting a monolith (each layer now
   grows independently, its gate recalibrated only by extraction or
   scope cuts — the ADR-0041 discipline per package). Future readers
   must NOT read "cli 1320 + tui 1520 > 2400" as a cap violation: the
   2400 single-package terminal cap is superseded by this ruling.
4. **Zero behavior change is the hard acceptance** of the extraction:
   all existing tests pass with zero assertion edits (import paths may
   move mechanically), the pipe output is byte-identical to 0.1.18,
   and the PTY smoke stream matches with only non-semantic
   differences (timestamps, wall seconds). The behavior suites — the
   idle probes, the scrollback flood, the interleave lint, kill -9 —
   all stay green.

## Consequences

- cli: 1099/1320 (221 headroom); tui: 1261/1520 (259 headroom). The
  cli's remaining feel-rounds (~30 lines) and future policy work fit.
- The tui package is reusable outside kiso (the desktop/office repos
  can render cells without importing the agent stack) — README marks
  it experimental, no API-stability promise yet.
- Release topology: kiso-tui enters the chain BEFORE the cli (the cli
  depends on it); 0.1.19 ships eight packages.

## Amendment 1 (2026-08-06): the cli gate 1320 → 1856 — one argued recalibration

The 0.1.23 config-surface round (ADR-0045) measured the cli at **1547**
code lines (comments + blanks stripped — the gate's snapshot basis, now
reproducible: `find apps/cli/src -name "*.ts" -exec cat {} + | grep -vE
'^\s*(//|/\*|\*|$)' | wc -l`), 227 over the 1320 gate. The overage is the
spec-forced Config increment (the settings surface, /model, the profile
resolution — ≈316 lines of the round's growth). Ruling: **the cli gate
recalibrates to 1856** (= 1547 actual + 20%, the same snapshot formula the
extraction used).

Boundary conditions, stated once so they never need re-litigating:

1. **The +20% is a snapshot metric, not an automatic ratchet.** A round
   that measures itself at N over the gate gets NO second recalibration
   for free — the formula only ever re-baselines from a snapshot taken
   by a review ruling, for SPEC-FORCED growth with an argument on the
   record. Self-adjusting the gate is a violation, not a precedent.
2. **The next approach without an argument is extraction, not a second
   recalibration.** The config layer is the ready candidate: the config
   loading / profile parsing can sink into the runtime (or a standalone
   module) without changing the CLI's surface — exactly the move that
   produced the 1320/1520 split.
3. The core gate stays 2000; the tui gate stays 1520 — no recalibration
   was requested or granted for them.

## Amendment 2 (2026-08-07): the tui gate 1520 → 2045 — the one-compositor recalibration

The TUI v6 round (ADR-0046) measured the tui package at **1704** code
lines, 184 over the 1520 gate. The overage is SPEC-FORCED — the v6
spec's architecture ruling: the two-writer split (body 686 + dock 211
= 897) consolidates into the ONE compositor (compositor 844 +
components 372 = 1216) — the single writer + the component tree +
the slot model. The +319 net buys the round's structural points:

- the frame machinery (the live region, the freeze path, the commit
  bookkeeping) — previously split across the body's render + the
  dock's redraw, now one place;
- the new mechanisms: the SGR-aware hard fold (invariant ①), the
  frame-derived cursor marker, the live-region cap with the force
  commit, the zero-timer scheduler.

Ruling: **the tui gate recalibrates to 2045** (= 1704 actual + 20%,
the same snapshot formula). The boundary conditions of Amendment 1
stand — this is the ONE argued tui recalibration; the next overage
without an argument is extraction (the components are the ready
candidate: the cell renders can sink into the runtime's presentation
layer), not a third recalibration.

## Amendment 3 (2026-08-08): the tui gate 2045 → 2400 — the TERMINAL cap (the ADR-0041 discipline)

The TUI v7 round lands six spec-mandated items in one package
(packages/tui): W6 (the box chrome + the `›` swap), W15 (the expand
key), W13/W14 (the collapse rungs), W19 (plan mode's product surface),
W20 (the todo live block). The package measured **2039** code lines at
the round's start — six under the gate — with the six items adding
well past 2045.

Ruling (review-issued, 2026-08-08): **the tui gate recalibrates to
2400, declared the TERMINAL cap** — the cli precedent (ADR-0041): the
gate number is no longer a variable; the way past 2400 is structural
extraction or scope cuts, decided by ruling.

Boundary conditions:

1. This is the tui's SECOND recalibration (1520 → 2045 at the v6
   extraction, → 2400 now). There is NO third: the next approach to
   the cap has the only way out be extraction — the components cell
   renderer is the ready candidate (the cell renders can sink into
   the runtime's presentation layer), exactly the move that produced
   the cli/tui split.
2. The +20% snapshot formula no longer applies to the tui gate — the
   cap is declared, not measured.
3. The cli gate stays 1856; the core gate stays 2000.
