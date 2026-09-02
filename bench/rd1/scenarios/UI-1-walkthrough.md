# UI-1 — the surfaces a single-frame gate cannot reach

The R4→R8a arc built gates for what a frame LOOKS like. What none of
them touch is TIMING inside a real session: a turn interrupted, a
message typed while work is in flight, a screen that has been alive
long enough to have scrolled, a panel arriving on top of a standing
block. Those are the surfaces this walkthrough exists to put a human
in front of, once, with the transcript kept.

Run against the INSTALLED binary, never the repo's dist — the release
ceremony's own rule, and the reason the 0.20.0 ceremony caught a stale
line in design.md that every source-reading gate was blind to.

```
OPENAI_API_KEY=… OPENAI_BASE_URL=… OPENAI_MODEL=… kiso
```

## The nine, in order

Each names what must NOT happen. A "pass" is the absence of the
failure, seen; anything ambiguous is a finding, not a pass.

1. **A long first turn.** Ask for something that runs eight or more
   tools. WATCH: does any row above the work ever move DOWN? The
   standing block's whole claim is that it does not.

2. **Steer.** While that turn is still running, type a sentence and
   send it. WATCH: the queue chip appears above the composer; the
   block keeps its rows; nothing above the block moves. Then watch the
   steer land — the turn should take it without the screen jumping.

3. **Interrupt.** Start another long turn and press `esc` mid-tool.
   WATCH: what the block says as it closes, and whether the fold row
   is honest about a call that never finished.

4. **An approval.** Trigger an edit in a mode that asks. WATCH: the
   panel takes the band over the standing block (R4's rule), and the
   block comes back intact when the panel closes.

5. **A parallel burst.** Ask for four files to be read at once. WATCH:
   all four names on screen, one `●` on the activity line, no row
   moving as they finish one by one.

6. **`ctrl+r`, mid-stream.** Open the viewer while a turn is running.
   WATCH: nothing enters the scrollback while it is up, and every
   displaced row comes back on close.

7. **`/` and the command band.** WATCH: the list opens on the bare
   slash, five rows and a counter, `↓` scrolls the window, the
   descriptions stay in one column.

8. **A long session.** Keep going past twenty turns. WATCH: after the
   screen has scrolled, does anything above still move? Resize the
   window; run `/rewrap`. This is the one the R7a gates could not
   reach — skip's monotonicity was only ever proved WITHIN a turn.

9. **Narrow + CJK.** Resize to ~50 columns and ask something that
   answers in Chinese with a long shell output. WATCH: R8a's
   four-column block indent costs width; check nothing tears and no
   row exceeds the terminal.

## What to keep

The whole scrollback, as a file, plus a note per item saying what was
seen — not "pass". A finding gets a number and a `bench/rd1/findings/`
entry like any other.
