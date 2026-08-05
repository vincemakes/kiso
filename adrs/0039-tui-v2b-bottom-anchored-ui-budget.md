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

## Amendment 2 (2026-08-05): v2c — the dock draws its own input line; the kiso brick motif

- **Status:** Accepted
- **Date:** 2026-08-05

**Context.** The v2b real-machine report (four symptoms: cursor drift while
typing, the sent text invisible after Enter, input swallowed during a run,
weak contrast) traced to ONE structural cause: readline's redraw assumes it
owns the row exclusively and positions by CHARACTER count — a CJK wide
character (2 cells) shifts every following column, and the dock's redraws
make the mismatch permanent (probe-confirmed: readline never re-syncs its
tracked cursor after an external move). Patching readline is a dead end.

**Decision.**
1. **The TTY path replaces readline with a zero-dependency raw-mode
   editor** (editor.ts): its own eastAsianWidth subset table (~40 lines),
   display-width cursor math and horizontal scrolling (a Chinese input
   landing on the correct display column is the hard acceptance), the
   minimal key set (UTF-8 printable, Enter, Backspace/Delete, arrows,
   Home/End, Ctrl+A/E/U/K/W, Ctrl+C/D, Esc), bracketed paste (?2004h/l)
   with newlines flattened to spaces (single-line editor). Non-TTY paths
   keep readline untouched — the pipe bytes are byte-identical to v2b
   (pinned by the diff). The idea is pi-tui's raw editor; the code is
   ours, still zero dependencies.
2. **The visual identity is the kiso brick motif** — the input row opens
   with a blue half-block ▌ (echoing the pixel logo) then blue you>;
   the separator is a dim dotted ╌ (a weaker presence than ─); the
   status bar is dim with blue accents. Deliberately NOT the CC rounded
   frame and NOT the pi editor.
3. **The user_input echo prints EXACTLY once into the scroll region** —
   the dock-era input row is not part of the body, so the event render is
   the only body copy; the line-mode (rows < 4) echo stays the editor's
   row. Turn submissions during a run queue on the chain with a live
   "+N queued" status.

**Consequences.** The cli gate holds at 1544/1600 (the editor is +~390
over v2b). Known limitation, documented in the README: emoji ZWJ clusters
are not width-perfect (each code point counts its own width). readline
remains in the non-TTY path only.

## Evidence
- `apps/cli/src/editor.ts`, the tui-v2c PTY e2e (Chinese cursor columns,
  exactly-once echo, +N queued, Esc abort, ?2004l), the pipe diff vs v2b.
