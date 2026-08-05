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

## Amendment 1 (2026-08-05): #13 (P1) — the DECSTBM region is GONE; the B route (plain LF scrolling)

- **Status:** Accepted
- **Date:** 2026-08-05

**Context.** The v2d freeze printed overflow lines at the region's bottom
row and relied on the DECSTBM region scrolling — but whether a
region-scrolled line enters the terminal's scrollback is terminal-
dependent (the v2d spec's ⚠): measured on a real terminal, LF=2 /
CSI-S=0 / ESC-D=0 — the region scroll dropped the lines, the old content
was overwritten in place, and the scrollback received zero bytes. The
v2d core clause — frozen cells enter the scroll region with native
scrolling preserved — was violated.

**Decision.** The DECSTBM scroll region is removed entirely (the B
route, the spec's preferred line). The body fills from the top without
scrolling; once full, every new frozen line scrolls the whole screen
with a REAL LF (`\x1b[H;1H\n`) and lands at the body's bottom row —
plain full-screen scrolling, which every terminal pushes into the native
scrollback deterministically. The dock rows are redrawn by the body
after every scroll. The cost is slightly more redraw traffic; the
correctness no longer depends on the terminal's region-scroll behavior.

Two defects surfaced and fixed while reproducing: (1) the runtime emits
no `text_end` (an adapter-level event) — the TextCell never closed, the
freeze blocked behind it, and everything after re-rendered in the tail
forever (the flood reproduced the overwrite ×38); the stream's next cell
is now the close signal. (2) the tail was sliced before the freeze —
a stale tail re-drew the frozen cells (×2); the tail is computed from
the final nextFrozen.

**Consequences.** The gate probe (tui-v2e) is a standing fixture: 3×
viewport flood, LF ≥ 104, early content exactly once, no DECSTBM. The
tmux scrollback (`capture-pane -S`) confirms the early content in the
native scrollback; Terminal.app and iTerm2 run the same sequence. The
pipe bytes stay byte-identical to the v2c baseline.

## Evidence
- `tui-v2e.test.ts` (the #13 gate), the body renderer's LF-scroll path,
  the plan record §10.
