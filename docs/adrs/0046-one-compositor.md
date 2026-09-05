# ADR-0046: TUI v6 — the one-compositor ruling

- **Status:** Accepted
- **Date:** 2026-08-07
- **Layer:** packages/tui (presentation)

## Context

The v2d/v3 TUI (ADR-0040) split the writer across `body.ts` (the scroll
region's cell renderer) and `dock.ts` (the bottom chrome) — two writers
of the same screen, coordinated through callbacks (`onDock`, `editCol`),
geometry caches (`#oldTailTop`, `#oldTailHeight`, `#height`), and two
independent resize handlers. Every finding since #13 has been a seam of
that split: the tail-ghost, the separator wall, the fold/body merge, the
stale-geometry clamp — each fixed by patching one half of the pair. The
v6 spec retires the split: ONE compositor owns every byte of the screen,
component-rendered, with the cursor derived from the frame itself.

## Decision

1. **ONE compositor** (`compositor.ts`) replaces `body.ts` + `dock.ts`
   (retired, ~600 lines gone): `Component{render(width): string[]}`
   leaves + `Container` composition; a single `doRender` is the only code
   that writes stdout. The CLI-facing façade (the `Body` mutations +
   the `Dock` chrome API) survives so the CLI itself is untouched
   (zero diff outside the tui package + tests).

2. **Pi mechanisms adopted** (the ruling's adoption list):
   - the Component/Container tree with width-parameterized rendering;
   - one `doRender` owning all output (no per-event writes anywhere);
   - bottom-up live-region repaint from the input row anchor, relative
     cursor moves only (no absolute rows in steady state — LF-scrolled
     rows shift, relative moves from the pinned anchor never go stale);
   - CSI 2026 synchronized output around every frame;
   - the crash-on-violation width invariant (pi `tui-main-screen.ts`
     :447-473): every emitted line's visible width ≤ the terminal width
     — components hard-fold themselves; the renderer THROWS with a
     diagnostic on violation, never a silent truncate;
   - the cursor marker embedded in the focus component's rendered line
     (an APC private sequence `ESC _ … ESC \`): the compositor locates,
     strips, and relatively positions the cursor from the frame —
     side-channel cursor bookkeeping (`editCol` arithmetic separate from
     the picture) is gone.

3. **The scrollback fork — where we part from pi**: pi renders a
   virtual screen and diffs it; nothing real enters the terminal's
   native scrollback (pi's scrollback is its own buffer). Our #13
   contract (ADR-0040, the B route) is that frozen content enters the
   NATIVE scrollback deterministically. So the compositor keeps
   `lines[] + commitIndex`: every line renders into the flat store; a
   line COMMITS (leaves the live region) by the real-LF scroll path
   (`\x1b[1B\n` at the last row — CUP-free) when its cell is DONE and
   the region needs the room. Committed bytes are never re-emitted by
   the frame path. **A settled resize is the one exception** (Amendment
   1): it erases the terminal's screen and scrollback (`2J H 3J`) and
   reprints the session at the new geometry, so the terminal holds
   exactly one rendering of the record at all times. The live region is
   hard-capped at **H−1 lines**; overflow
   force-commits the oldest live line unconditionally — the ONE sharp
   edge this round introduces, pinned by the VT-emulator gate asserting
   the scalar directly.

4. **Two crash-enforced invariants** (pinned by tests):
   ① visible width ≤ W on every emitted line (see the adoption list);
   ② within the LIVE REGION, only RELATIVE cursor moves (vertical
   `\x1b[{n}A/B`, horizontal `\x1b[{c}G` + `\x1b[0K`); CUP exists only
   in the full-redraw path (the first frame, the resize repaint) and
   in the FREEZE path — the committed lines' writes at
   `[liveTop−N .. liveTop−1]` are absolute CUP (the old code's frozen
   writes were CUP too; the frozen rows are computed from the current
   geometry, so external writes — the CLI's console.error CRLF — cannot
   misplace them the way a relative march could). The rows clamp at 1:
   a super-tall force-commit's early lines have no on-screen row (a
   negative CUP is terminal undefined behavior); their content stays
   in the scrollback.

5. **Slots, not overlays**: `chatContainer` (Banner / UserMessage /
   AssistantMessage / ThinkingFold / ToolExecution / ErrorLine / Recap,
   fed by render.ts's original text) → `statusContainer` →
   `editorSlot` (exactly one occupant: **Editor** | **ApprovalPrompt** |
   **MenuSelect** — the focus follows the occupant) → `footer` (one
   dotted row). Approval and menu are slot SWAPS, never overlay layers
   (the old dock's overlay rows are gone — the #17 separator wall
   cannot return by construction).

6. **Zero timers**: no heartbeat interval. The spinner animation is a
   dirty flag through the scheduler — a one-shot setTimeout re-armed
   only while a running tool exists (the #14/#15 zero-output contract
   becomes structural: no animation → no timer → no bytes).

## The ghost-spectrum mapping (the recorded user symptoms → the v6
mechanism that kills each)

| recorded symptom | root cause (≤ v5) | v6 mechanism |
|---|---|---|
| first frame | startup CUP draws over shell leftovers / pre-clear | H line feeds scroll the inherited screen into the scrollback; the frame then owns rows 1..H (DC-40). The feeds precede the entry reset: `ESC[r` homes the cursor, and feeds after it scroll one row, not r (DC-40, 2026-09-02; the row read "sequential emission from the current position" from v6 to 0.20.3 while the bytes were absolute CUP) |
| logo row cut | soft-wrap + reflow split a logo row | invariant ①: each row hard-folds ≤ W and emits whole |
| same-row duplicate | two writers painting one row (body + dock) | one compositor: every row written once per frame after `\x1b[0K` |
| approval takeover | question rendered as an overlay at the status row | the ApprovalPrompt SLOT occupant — the question takes the input row, focus follows |
| concatenated lines | per-event writes interleaving cells | one doRender; components never share a line |
| fold/body merge (reflow) | pre-fill CUP rows reflowed as soft lines (#17) | real-LF commits (scrollback fork) — committed lines are logical lines |
| tail ghost / separator wall (resize) | stale geometry + overlay chrome | **Amendment 1**: a settled resize = `2J H 3J` + a reprint of the session at the new geometry, staged through the scrollback exactly as a resumed session's replay is. A same-size SIGWINCH emits nothing |
| idle leak (#14/#15) | 200ms heartbeat re-painting | zero timers (decision 6) |

## Consequences

- `body.ts` / `dock.ts` and their tests retire; `compositor.ts` +
  components + the compositor unit tests replace them. render.ts /
  diff.ts / editor.ts width primitives survive untouched.
- The gate re-baseline (risk 3): storm, flood, idle thresholds are
  re-derived against the v6 byte model one by one and documented in the
  round report; a gate that goes green WITHOUT a threshold change is
  treated as a regression signal and investigated.
- The `\x1b[r` exit byte survives as the "no broken terminal" contract
  (harmless — no DECSTBM was ever set).

## Trade-off note (the 0.1.35 round — recorded so the next lab pass
does not re-report it as a new finding)

- **V6-1's scrollback cost under a shrink storm** — STRUCK by Amendment
  1. There is no extra copy: the terminal holds one rendering of the
  session, because the settle erases what it held before reprinting.
- **Fix C is a sanctioned reinterpretation of invariant ②, not a silent
  retirement**: the steady frame CUPs the LIVE lines at their model rows
  (the relative march drew them adjacent to the chrome, where the
  unclamped geometry's gap ELs erased them — the streamed text was
  invisible until the commit frame). The byte-truth contract (the
  compositor header + the machine gate `cups.every(r => r ≤ content
  area)`) is: every steady-frame CUP lands in the CONTENT area (rows ≤
  H−4−menu — the committed band, the stale/gap ELs, the live lines at
  their model rows); the CHROME rows (H−3..H) are relative-only; CUP
  over the whole screen exists only in the full-redraw path.

---

## Amendment 1 (2026-09-05) — a settled resize erases and reprints

§3's clause "The committed bytes are never re-emitted (zero replay,
zero `\x1b[3J` — the user's shell history is never touched)" becomes:

> Committed bytes are never re-emitted by the frame path. A settled
> resize is the one exception: it erases the terminal's screen and
> scrollback (`2J H 3J`) and reprints the session at the new geometry,
> so the terminal holds exactly one rendering of the record at all
> times.

**What it costs, declared.** The history the terminal held before kiso
started is erased at the first resize. That is the price, chosen
2026-09-04 against the alternative — a transcript whose scrolled-off
part never reflows — after both were measured on the owner's own
terminal (R10 §6). kiso's own record is unaffected: the session log
holds it and `--resume` replays it. The reference implementation's
measured behaviour is the same, 0-of-60 shell lines surviving in every
direction, so this is a behaviour being adopted rather than introduced.
A gate asserts the 0/60 so the cost cannot drift silently.

**Why the old clause could not hold.** It promised that kiso never
touches the terminal's history, and R10 measured otherwise: the first
frame already erased the visible screen row by row (DC-40), a grow lost
16 rows outright (DC-39), a narrow duplicated four tokens, and the
scrolled-off part of the transcript never reflowed at all. Those are
one fault seen from four sides — kiso doing window arithmetic over rows
the terminal had already reflowed underneath it, carrying `#scrolledOff`
across a fold change that makes every index mean something else. No
design under the old §3 removes the seam, because the scrollback is the
terminal's and `3J` is the only instruction that rewrites it.

**Consequences.**

- The ghost-spectrum row "first frame" becomes: "H line feeds scroll
  the inherited screen into the scrollback; the frame then owns rows
  1..H (DC-40)."
- The trade-off note's "at most one extra copy per resize" is struck:
  there is no extra copy.
- DC-34's rules 1–3 (the adopt, the width clamp, the frontier-scoped
  refold), the `#refolded` latch and the width latch retire with the
  counter they served. DC-37 is moot. DC-19's two halves apply
  unconditionally.
- **DC-50** rides the same mechanism: `ctrl+o` is a global switch and
  flipping it is the same reprint, which is what makes a committed
  card's body reachable without printing a second copy of it.
- Path independence (V6 ②) stops being an exception granted to
  non-overflowing storms and becomes the contract: the terminal holds
  one rendering of a transcript that does not remember how it got here.
