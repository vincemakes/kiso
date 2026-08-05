# ADR-0039: the bottom-anchored UI is a deliberate budget — pi-tui's idea, not its implementation

- **Status:** Accepted
- **Date:** 2026-08-05
- **Layer:** apps/cli (presentation)

## Context

The user-recording spec (2026-08-05, TUI v2b) asked for a bottom-anchored
UI: the body scrolls in a DECSTBM region, the bottom three rows (dim
separator, live status bar, input line) never move, and resize/teardown
leave no broken terminal. The reference in this product class is pi's
`pi-tui` — the same idea (a reserved bottom, synchronized output against
flicker). The open question was whether to take pi-tui as a dependency.

## Decision

1. **Borrow the IDEA, not the implementation** (the v2a ruling,
   extended): pi-tui is a component system — a differential renderer with
   an internal tree, diffing, and layout. kiso's CLI stays at line-level
   ANSI, zero dependencies. The dock is ~110 lines: DECSTBM on enter,
   CSI r on exit (finally-guaranteed, kill -9 excepted), cursor
   positioning for body writes, a three-row redraw wrapped in CSI 2026
   (synchronized output — the pi anti-flicker trick, taken as an escape
   sequence, not a library), SIGWINCH re-application.
2. **The cli gate moves 1200 → 1600** — a deliberate, recorded budget
   decision, not a drift: the bottom-anchored UI costs ~370 lines on top
   of v2a (dock.ts, the status-bar/tail/body plumbing in index.ts, the
   content strategy folds). At completion: 1121/1600. The gate is still
   HARD: if v2b's successor needs more, it must justify a new decision.
3. **The content strategy is presentation-independent**: thinking folds
   to one dim line (first 100 chars + " (… /think shows full)"), the
   [result] echo truncates at 160 chars + " (/last for full)", the body
   text deltas stream in full — in pipes and TTYs alike. The pipe-mode
   byte diff vs v2a shows EXACTLY the declared differences and nothing
   else.
4. **Scope stays out**: alt-screen, differential rendering, component
   systems, mouse, images, autocomplete, pi-tui as a dependency — all
   explicitly out. /think is the only new command.

## Consequences

- The CLI remains dependency-free for its TUI; every escape sequence is
  ours to understand and test (the PTY e2e asserts the actual bytes).
- A terminal without a real window size (rows < 4) stays in v2a line
  mode — the bottom three rows need room to exist; pipes and NO_COLOR
  never dock.
- Resize is a first-class contract: SIGWINCH re-applies the region; the
  teardown (exit / signal / exception) resets it via `\x1b[r` in a
  `finally` — a `kill -9` can leave a broken terminal, and the README
  says `reset` saves it.

## When to revisit

If a future round needs a component system or differential rendering, the
gate decision is the forcing function: it must clear 1600 with its own
ADR.

## Evidence

- Commits: the v2b round (dock.ts, index.ts plumbing, render folds).
- The gate: `scripts/check-size.mjs` (cli 1600); the pipe byte diff is in
  the plan record `docs/plans/2026-08-05-tui-v2b.md`.
