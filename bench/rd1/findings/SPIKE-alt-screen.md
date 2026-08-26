# SPIKE — the alternate screen: what it would buy, measured

- **status:** SPIKE. Measured on a branch, not shipped, nothing changed
  by default. `KISO_ALT_SCREEN=1` selects it.
- **question:** the owner asked why kiso does not use the alternate
  screen, "it's very clean". ADR-0040 recorded the choice to put content
  in the terminal's NATIVE scrollback with real LFs — but no ADR has
  ever evaluated the alternate screen. It was never on the table, so the
  question is open rather than settled.

## What was built

`ESC[?1049h` on entry, `ESC[?1049l` on exit, nothing scrolls while on
the alternate screen, and the committed transcript is printed to the
PRIMARY screen on the way out — the third option, so the history still
survives the session.

## The results

**It buys nothing in per-frame cost. Nothing at all.**

| | primary | alternate |
|---|---|---|
| full-screen stream, erases/delta | 10.5 | **10.5** |
| full-screen stream, bytes/delta | 1081 | **1081** |

Identical, and the reason is worth stating because it was the intuition
this spike was meant to test: the per-frame cost comes from the WINDOW
SHIFTING when the live band grows, and a diff has to rewrite the rows
that moved whether or not the ones leaving the top go anywhere. The
scroll was never the expensive part.

Short-session total bytes did drop, 5378 to 4149 (−23%), which is the
staging writes that no longer happen — real but small.

**What it buys is complexity and defect CLASSES.**

- `#emitScroll` — 39 lines, 22 of them code — becomes unreachable, with
  `#scrolledOff` (7 references), the floor, the chunked transit, the
  staging and the resize scroll-adoption.
- REL-0152-D7's class becomes impossible: nothing is irreversible, so
  "painted over, then the wrong row scrolled" cannot happen. That class
  cost six built-and-reverted fixes and an architecture round.
- REL-0152-D18 becomes impossible: no scrollback to deposit into.
- REL-0152-D1 becomes impossible: no prompt-looking rows for the
  terminal to mark.
- REL-0152-D17 degrades from PERMANENT residue to transient — the next
  frame repairs it.

**The exit transcript works, with one gap the spike found.** 4 of 5
turns came back on the primary screen; the fifth was still LIVE and the
dump only writes committed cells. Fixable, and worth knowing that the
naive version silently drops the last turn.

## What it costs

**Mid-session scrollback goes away immediately.** Anything above the
window is unreachable until exit — no terminal scrollbar, no native
copy, no native search over the session so far. Scrolling up to re-read
what the model said two minutes ago is a frequent action and the durable
log is not a substitute for it without a viewer someone has to build.

**The migration is not cosmetic.** 23 test files touch the scrollback,
and for several of them it IS the asserted property, not an incidental
detail — a7-replay (6), tt1-clamp (12), tui2-r2pre-scrollback-gaps (9),
compositor (7). Those do not get adjusted; they get re-pointed at a
different property or retired. Two ADRs would need superseding: 0040
(which chose real LFs precisely so that content reaches the native
scrollback deterministically) and 0046.

## The honest read

The case is NOT performance — that intuition is dead, measured twice.
The case is that a whole family of defects becomes unreachable and a
piece of the renderer stops existing.

The bill is one real user capability, and it is the one the product has
been claiming: the transcript IS the terminal's own history, scrollable
and searchable with the terminal's own tools, during the session and
after it.

That is an owner's decision about what kiso is, not an engineering
decision about what is cheaper. The spike's job was to make sure it is
decided with numbers, and the numbers say the trade is
**complexity-and-defect-classes against mid-session scrollback** — not
speed, and not elegance.
