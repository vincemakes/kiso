# ADR-0040: v2d — the body renderer: ONE writer, frozen cells + an active tail

- **Status:** Accepted
- **Date:** 2026-08-05
- **Layer:** apps/cli (presentation)

## Context

The v2b/v2c body wrote each event's bytes directly into the scroll region
(bodyWrite per event). Two structural problems followed: **interleaving**
— the tool lines, thinking folds, and text deltas could merge in the same
frame (the region's cursor math is shared), and **the leak** — a tool's
life was scattered across several writes (the call line, the running
line, the result line), so the trace of one tool was not one thing. The
user's v2d spec asked for a cell model and authorized the cli gate
1600 → 2100 (the bottom-anchored UI's accumulated cost: 1922/2100 at
completion).

## Decision

1. **ONE writer**: the new `body.ts` render loop is the only code that
   writes the stdout scroll region. Every event handler ONLY mutates cell
   state — interleaving is impossible **by construction** (pinned by the
   interleave-lint e2e: three parallel tools + an approval + a long
   thinking block + streaming text in one frame; every reconstructed line
   must fully match the known cell format set).
2. **The cell model is ours** — UserCell / ThinkingCell / ToolCell /
   TextCell / NoticeCell / raw block / terminal — deliberately NOT pi's
   Component interface shape (a tree, diffing, layout). Ours is a flat
   list of single-line cells with two states (done / active), ~60 lines
   of rendering, zero dependencies.
3. **Frozen semantics**: a completed cell prints its final form into the
   region ONCE and is never touched again. The ACTIVE TAIL — the
   unfinished cells — renders at the region's bottom (between the frozen
   area and the dock) and redraws in place, CSI 2026 wrapped, reusing the
   v2c cursor math. An over-height tail (rare) overflows to freeze by
   completion order.
4. **Frame scheduling**: state changes coalesce to ≥16ms frames; a 200ms
   heartbeat drives the running spinners and elapsed timers.
5. **ToolCell lifecycle** (the leak cure): ONE line — `→ name 摘要`
   (params ≤ 60 chars) → the ⏸ badge while an approval is pending (the
   question still reads at the dock's input row) → running (blue spinner
   + `Ns`) → frozen `✓ name (摘要, 1.2s)` / `✗ name (错误首行, 1.2s)`.
   The `[result]` full text no longer flows — `/last` (and `/think`) read
   the body's final cell states. Parallel tools each have their own cell.
6. **Pipes / non-TTY bypass the renderer entirely** — the Body runs in
   passthrough and reproduces the v2b/v2c line-mode bytes EXACTLY (the
   byte diff vs the v2c baseline is EMPTY, including the terminal label
   `\ndone\n` that a first integration pass had dropped).
7. **Difference from pi's full-viewport redraw, recorded**: pi re-renders
   its whole component tree per frame; kiso only redraws the tail (the
   frozen area is append-only) — the freeze is the optimization, and the
   terminal's own scrolling handles the region overflow.

## Consequences

The cli gate is 2100 (the user-authorized raise; ADR-0039's Amendment 2
budget absorbed the editor, this is the body's own line). The TTY and
pipe outputs now diverge by design (the ToolCell's single line vs the
pipe's summary + [result] — each pinned by its own tests). readline
remains on the non-TTY path only; the editor owns the input row; the
body owns the region — three writers, three disjoint surfaces.

## When to revisit

If a future round needs markdown rendering or syntax highlighting (next
round candidates), the cell model is the seam: a TextCell could gain a
rich render without touching the writer rule.

## Evidence

- `apps/cli/src/body.ts` (the renderer), the tui-v2d interleave-lint e2e,
  the body unit tests (freeze-once, in-place redraw), the EMPTY pipe
  diff vs the v2c baseline, the plan record
  `docs/plans/2026-08-05-tui-v2d.md`.
