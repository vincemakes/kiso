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

## Amendment 4 (2026-08-09): the tui-cells extraction — the 9th package, its own gate

The TUI v8 round (the approval & input design) hit the Amendment-3
wall: the tui measured 2394/2400 — six lines — with the round's
additions (+200) against the in-place retirements (−56). Amendment 3
names exactly one way past the cap: structural extraction of the
components cell renderer, decided by ruling. Ruling (review-issued,
2026-08-09): **the extraction executes** — the cell renderer leaves
`packages/tui` for a new package, `packages/tui-cells`
(`@vincemakes/kiso-tui-cells`, the 9th published package).

**The boundary is the module.** The extraction moves `components.ts`
(588 code lines), `diff.ts` (100), `width.ts` (29 — the helpers'
width primitives must not import back into the tui, the acyclic
rule), and the render.ts cell-rendering slice (207: the twelve
helpers components.ts imports — escapeTerminal, palette, foldThinking,
foldResult, colorInlineCode, renderTerminalGap, renderToolSummary,
toolTarget, kUnit, bannerLines, Palette, ResumeMeta — with their
private closure: COLOR_ON/COLOR_OFF, TAGLINE, the logo rows,
truncateRow, renderResumeList, relativeTime, titleCut,
toolSummaryDetail, exitCodeOf). Moved, never duplicated: render.ts
imports the slice back from tui-cells and re-exports it, so the
tui's public surface (index.ts) is byte-identical for consumers and
compositor.ts keeps its imports verbatim. The extraction measures
**924 code lines**; the tui lands at ≈1490/2400 — the cap untouched,
no third recalibration.

**The gates re-base** (the per-package discipline, Amendment 1:
actual + 20%, the same snapshot formula the original split used):

| package | gate | note |
|---|---|---|
| core | 2000 | unchanged |
| cli | 1856 | unchanged |
| tui | 2400 | the TERMINAL cap — untouched (Amendment 3) |
| tui-cells | **1280 (declared)** | = 1.2 × 924 (the extraction actual) + ≈170 (the v8 panel's growth — the approval panel rides tui-cells: it IS a component) |

**The zero-runtime-dependency property moves.** ADR-0043's original
claim ("zero runtime dependencies: input is data, output is bytes")
now belongs to tui-cells. The tui gains its ONE runtime dependency —
the re-export shims (components/diff/width/render stay at their old
paths, importing from `@vincemakes/kiso-tui-cells` subpaths) — the
cli's imports are untouched. The cli depends on tui; tui depends on
tui-cells; the chain stays acyclic.

**The release topology changes.** Nine packages ship in one release;
tui-cells publishes BEFORE tui (the packed-smoke discipline — the
symlink-shadow trap from the release memory: the gate must not
silently run the old code). The cli's pin on the tui moves in the
same batch as the version bump.

Boundary conditions:

1. The zero-behavior acceptance of ADR-0043 decision 4 applies to
   this extraction unchanged: all tests pass with zero assertion
   edits (import paths may move mechanically), the pipe output is
   byte-identical, the PTY smoke stream matches with only
   non-semantic differences. The moved tests pass in the new package.
2. The tui-cells gate is NOT a terminal cap — it follows the
   Amendment-1 snapshot discipline per package (a round that measures
   itself over the gate gets no automatic recalibration; the next
   approach without an argument is extraction, not a raise).
3. The panel (W21) and the v8's other components (the pending-queue
   chips) land in tui-cells; the tui gate carries only the slot
   wiring — the compositor's bindApproval/bindQueue leads, the
   editor's panel leads, the cursor contract, and the render-bug
   fixes — against the retirement ledger (−56).

## Amendment 6 (2026-08-11): the cli gate 1856 → 1920 — the R-D first-run earmark (the second and LAST cli recalibration)

The R-D 0.1.45 round (the adoption round) measured the cli at **1849/1856**
— seven lines of headroom — with the spec-forced first-run scaffold
(deliverable B) still queued. The owner's stop-clause ruling (2026-08-11,
the R-D stop-clause ruling exchange — the second textbook ledger stop,
R-E's ledger stop being the first; the ledger carries no records):
**the cli gate recalibrates to 1920 (+64), earmarked exclusively to
deliverable B (the first-run scaffold), recorded as this Amendment.**

The ruling's operative substance, carried here verbatim-in-substance from
the ruling exchange (the exchange is the record; this Amendment is its
governance trace):

1. **Option (a) rejected** — seven lines cannot hold the first-run
   sequence without distorted code or a neutered first-run story, and
   the first-run experience is the adoption round's bullseye.
2. **Option (b) rejected as the main path** — line-hunting inside the
   cli during the round is unfocused zero-behavior risk; incidental
   in-place trims of ≤10 lines are not forbidden, but no dedicated
   expeditions.
3. **The rationale chain**:
   - The standing rule: a cli overage is a product-growth raise (the
     legal path); a core overage is expulsion. This increment is a
     spec-forced deliverable of the R-D round, owner-adjudicated —
     the former.
   - Amendment 1's attached clause ("the next approach without an
     argument is extraction, not a second recalibration") does not bar
     this raise — the approach HAS an argument (spec-forced). But the
     clause's spirit demands a higher threshold: +64 is a MEASURED
     need, not the +20% blanket formula. B's real shape: the first-run
     detection + the trust-sequence wiring + the config scaffold
     writes + the startup-path integration ≈ 40-60 lines. F's demo
     lives in scripts/ and does not touch the cli; C/D/E do not touch
     the cli — B is the only budget consumer; the earmark is honest.
   - Snapshot discipline: one pinned number, no self-adjusting ratchet.
     If B lands smaller, the round report shows the honest delta; the
     number does not roll back.
4. **Consequence clause (hardened)**: this is the cli's SECOND and LAST
   recalibration before 1.0. The next approach — with or without an
   argument — defaults to extract-first adjudication; a recalibration
   requires extraordinary justification.
5. **Numbering discipline**: Amendment 5 is permanently retired (the
   forged number, rolled back — the scar stays visible in history).
   This ruling is **Amendment 6**, citing the 2026-08-11 R-D
   stop-clause ruling exchange as the actually-issued ruling.

Conditions attached to the raise:

- This Amendment lands BEFORE deliverable B's code (governance before
  implementation).
- B delivers its own line account (actual vs the ≤64 envelope) into
  the round report.
- The Route-1 seven-conditions evidence is accepted; the symlink-shadow
  check, deferred to the staged-bump moment, becomes an explicit
  checklist line in the round report's release section (evidence cited
  at release time).
- The faux-delay measurement fix is associated with the unidentified
  flake from the 0.1.44 acceptance full-suite; if the round's full-suite
  reruns stay stable, the P4 observation item closes as "located".
- The eight storm/banner/resume re-baselines are ratified — the
  rationale in the test comments is the correct form; the emulator-
  replay evidence is cited on record.

The cli gate is **1920**. The core gate stays 2000; the tui gate stays
2400 (the terminal cap); the tui-cells gate stays 1280.

## Amendment 7 (2026-08-17): the product-era tui cap — 2,400 → 4,000

The owner's ruling (2026-08-17, adjudicated with the KC2 round).
Amendment 3 declared 2,400 the tui's TERMINAL cap and named structural
extraction the only way past it. That clause was sized for the
framework era, when the terminal layer was a fixed surface to hold
still. The KISO CODE SUPREMACY queue (KC2–KC5: redirect, ask-user
option panels, session finder, expand/collapse richness) makes TUI
growth SPEC-MANDATED product work — and per-feature extraction into
ever more packages would fragment one coherent surface to satisfy a
cap calibrated for a different era.

Ruling: the tui gate recalibrates 2,400 → 4,000. Amendment 3's
"never a third recalibration" clause is superseded — by explicit
ritual, never silently. Unchanged: the cli's 1,920 stays terminal
(extract-first, Amendment 6); tui-cells stays 1,280; the tui-cells
extraction hatch remains available and preferred for component-shaped
growth; the 4,000 cap is once again a snapshot discipline, not a
self-adjusting ratchet.
