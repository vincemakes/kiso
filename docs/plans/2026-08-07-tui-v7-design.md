# TUI v7 — the design round (proposal)

Status: proposal. No code changed yet. The preview script renders every
frame below at a real terminal width; run it before reading further.

    node scripts/tui-v7-preview.mjs            # colored, your width
    node scripts/tui-v7-preview.mjs --plain    # zero SGR — the pipe contract
    node scripts/tui-v7-preview.mjs --width 64 # the narrow check

## Why now

Two things changed under the current TUI and it has not caught up.

1. **kiso has a mark.** `kiso-work/logo.svg` is a ring: a scalloped
   circle, a second copy rotated 45 degrees at 0.58 scale, and a solid
   centre dot. The TUI banner still draws `K I S O` block letters
   (`render.ts:386`) whose comment claims it is "the logo.svg pixel
   form". It is not, any more.
2. **v6 landed the one-compositor** (ADR-0046) and, with it, the
   component tree. Every screen line is now a component that folds
   itself. That is exactly the substrate a design system needs — and
   nothing has used it yet. The glyph vocabulary is still the
   accumulated set from v2a..v6: `▍ ▎ ▞ ▖ ▣ □ → ✓ ✗ ⏸ ╌ ▌ …`, eleven
   glyphs with no rule behind them.

## The constraint that shapes everything

kiso guarantees pipes and `NO_COLOR` carry **zero ANSI**, byte-checked
by the e2e gates. So the design cannot encode information in color.
Color is emphasis; structure carries meaning. Every frame in the
preview is checked at `--plain` first — that is the reason the tool
metadata moved back inside parentheses instead of leaning on `dim` to
separate it.

The second constraint is invariant ① — every emitted line's visible
width ≤ W, or the compositor throws. Every proposal below folds.

## 1. The banner: the wordmark stays, and gets bigger

**The pictorial ring is out.** logo.svg reduced to a 3-row cell grid
read as a hexagon, not as the mark — a scalloped ring with a rotated
inner ring needs more resolution than three rows of block glyphs have.

**The block wordmark stays, and it gets bigger.** It is the startup
banner, and the startup banner is the point. v7 keeps it **uppercase**
— the case decision is the author's; the note below records the one
tension it leaves.

**BIG — the default, 36 x 6:**

```
██    ██  ██████  ████████  ████████
██  ██      ██    ██        ██    ██
████        ██    ████████  ██    ██
████        ██          ██  ██    ██
██  ██      ██          ██  ██    ██
██    ██  ██████  ████████  ████████
```

Two properties worth keeping:

- **`█` and space only.** No `▀ ▄`, so there is no half-block seam to
  lose in a font that renders the halves at the wrong height. This is
  what the earlier lowercase draft could not have at three rows.
- **Each pixel is two cells wide.** A terminal cell is roughly 1:2, so
  one-cell pixels render a 4x6 capital at 1:3 — tall and spindly.
  Doubled horizontally it lands at 8x6 cells = 2:3 on screen, the normal
  proportion of a capital.

At 36 columns plus a 2-column indent it needs 38, so it still clears a
40-column terminal.

**COMPACT — 15 x 3: v6's own rows, unchanged.** They are already
uppercase, so the small size needs no redraw and nothing regresses:

```
█ █ ▀█▀ █▀▀ █▀█
█▀▄  █  ▀▀█ █ █
▀ ▀ ▀▀▀ ▀▀▀ ▀▀▀
```

**The case tension, recorded not argued.** The site sets the wordmark
lowercase everywhere (`<span class="logo-text">kiso</span>`,
`kiso-work/index.html`), so the terminal banner and the site now differ
in case. That is survivable — a display cut and a text wordmark are
allowed to differ — and the line under the art deliberately does not
repeat the name, so the two cases never collide in one view. Frame 7 of
the preview renders the lowercase cut at the same size if it is ever
worth revisiting.

The banner picks its size from the room it has, extending the rule
`bannerLines` already has (skip the logo under 40 columns):

| terminal              | banner       |
| --------------------- | ------------ |
| >= 40 cols, >= 20 rows | BIG (36x6)   |
| >= 40 cols, 14-19 rows | COMPACT (15x3) |
| under that            | text only    |

The text line under the art does **not** repeat the name — the art is
the wordmark, so it reads `v0.1.32 — the coding agent that survives
kill -9`.

The one animated glyph stays: `▖ ▘ ▝ ▗`, v6's existing spinner. The
recap keeps v6's `▞` — with no pictorial mark there is no seal glyph to
promote, and `▞` already reads as "a header in kiso's voice".

## 2. One gutter column

Every transcript row starts with a one-cell gutter, so the left edge
alone tells you what happened. This replaces the current mix (user gets
`▍`, tools get `→`, assistant text gets nothing, results get two
spaces).

| gutter | meaning                     | weight |
| ------ | --------------------------- | ------ |
| `▍`    | you spoke                   | bold   |
| (none) | kiso spoke — content is the default | plain |
| `⋯`    | thinking, folded to one row | dim    |
| `◦`    | tool queued                 | dim    |
| `▖▘▝▗` | tool running                | bold   |
| `✓`    | tool settled                | bold   |
| `✗`    | tool failed                 | red    |
| `⏸`    | tool waiting on you         | bold   |
| `▞`    | a header in kiso's voice    | bold   |
| `└`    | a detail of the row above   | dim    |

`◦` replaces `→` for the queued state specifically because `·` is the
separator used inside every metadata group; a queued marker that is
also the separator glyph reads as noise.

Tool rows pad the verb to 5 columns (`read write edit shell list` — the
names already have `_file` stripped by `renderToolSummary`), which makes
the target column line up into something scannable:

```
✓ read  packages/tui/src/compositor.ts (912 lines, 0.2s)
✓ edit  packages/tui/src/compositor.ts (+9 -4, 0.1s)
✗ shell npm run lint (exit 1, 0.9s)
  └ compositor.ts:712 — prefer-const
```

## 2b. The sent user message

Requested: the sent message should read as a solid block — dark ground
with light text on a light terminal, and the reverse on a dark one.
**The input box is not affected**; only the message after it is sent.

**The primitive is SGR 7 (reverse video)**, closed with SGR 27 rather
than SGR 0 so it composes with a surrounding bold or dim span. SGR 7
inverts against the terminal's *own* two colours, so it satisfies both
halves of the request with no theme detection, no configured palette,
and it still works on a user theme nobody has seen. No other attribute
does this — an explicit black background is wrong on half the terminals.

Two cuts were drawn (preview frame 10):

- **B, the full-width band** — every row padded to W. On a long message
  it looks right; on `/think` it paints a full-width bar for one word.
- **C, the inset chip** — padded to the longest row plus one space each
  side, indented two. The block is only as wide as what was said.

**C is the recommendation**, on the strength of the short-message case.

Two constraints ride along:

- SGR 7 is an SGR, so pipes and `NO_COLOR` drop it. The `▍` rail
  therefore **stays** as the structural fallback that survives a pipe —
  the block is emphasis layered on top, never the only marker.
- The band must fold before it paints, and every row must be padded to
  the same width or the block gets a ragged right edge. `foldLine`
  already reopens an open SGR span after a break, so a wrapped block
  keeps its paint on continuation rows; what it does not do is pad, so
  the component must.

## 3. The collapse ladder

The piece with the most leverage, and the piece kiso has none of today.
Four densities, same content:

**live** — the running tool keeps a short tail of its own output, so a
long shell command is not a frozen row.

**settled** — one row per tool. This is today's v6 behavior and stays
the default.

**rolled up** — when one turn issues N > 2 calls of the *same* tool,
they collapse to one row plus `└` children. This is Claude Code's
`groupToolUses` (`src/utils/groupToolUses.ts`: group by `message.id`,
only for tools that opt in via `renderGroupedToolUse`, skipped entirely
in verbose mode). The same rule fits kiso's cell model directly — group
by the assistant message that issued the calls.

```
✓ read  5 files (2.4k lines, 1.1s)
  └ compositor.ts · components.ts · render.ts
  └ +2 more — ctrl+r expands
```

**folded** — a whole quiet turn, once it is scrollback, becomes one
row: `▞ thought 19s · 5 reads · no edits`. This is the "Thought for 5s,
ran 1 shell command" roll-up in the reference.

Ladder rung 3 and 4 need an expand key. `ctrl+r` is the proposal
(verbose toggle), matching the reference's verbose mode.

## 4. The chrome

v6 is four rows: dotted rule, input, dotted rule, status. The proposal
keeps **four rows** — `CHROME_ROWS` does not change, so the live-region
geometry and every gate that depends on `H − 4` are untouched — but
swaps the two rules for a rounded box:

```
╭──────────────────────────────────────────────────────────╮
│ › fix the resize repaint                                 │
╰──────────────────────────────────────────────────────────╯
ready · deepseek-v4-flash                / commands · ↑ history
```

The box encloses instead of sandwiching, and the rounded corner matches
the brand's 10px radius. Inside the box the prompt goes light (`›`
instead of v6's `▌`) — the box already says "input lives here", and a
second heavy bar just doubles the rule.

The cursor keeps deriving from the frame marker; borders are only a
prefix width, so `CURSOR_MARKER` handling is unchanged. The line-mode
path (`editor.ts:219`) keeps `▌ ` — the box is a compositor-path
change only, so the pipe bytes stay identical.

Frame 6 of the preview renders A (box) against B (rails) at the same
width for a direct comparison.

## 5. The opening screen

The reference spends this space on "What's new". kiso's differentiator
is that it survives `kill -9`, so it should spend the space on what you
can pick back up:

```
  kiso v0.1.32  —  the coding agent that survives kill -9
  deepseek-v4-flash · ~/devv/kiso · mcp skills subagent todo

  ▞ resume
    2h ago  fix the resize repaint storm            41 events · 3 runs
    today   v6 one-compositor gates                183 events · 12 runs
```

The resume rows come from `renderSessionLine`'s existing metadata —
`kiso sessions` already has every field. Under 40 columns the resume
block drops, exactly as `bannerLines` already sheds the logo today.

## 6. The flow contract

The worry this section answers: a big diff or a long run piling up, and
the stream jittering while it does. Both are real today, and the first
one is measurable.

### The measurement

`truncateDiff` (diff.ts:84) caps at `MAX_DIFF_LINES = 40` — but that
counts **DiffLine entries**, and `ToolExecution` then pushes each one
through `foldLine`, which can turn one entry into three rows. A
realistic 60-line TS edit:

| width | source lines after truncateDiff | actual screen rows |
| ----- | ------------------------------- | ------------------ |
| 120   | 37                              | 37                 |
| 80    | 37                              | **73**             |
| 60    | 37                              | **73**             |

On a 44-row terminal the content cap is `H − 4 = 40`, so that approval
diff force-commits ~33 rows into scrollback inside a single frame. The
cap is not wrong, it is measured in the wrong unit.

### R1 — caps are counted in screen rows, after the fold, at the current width

pi already does exactly this: `truncateToVisualLines(text, N, width)`
renders to visual lines first, then keeps the last N
(`visual-truncate.ts:27`). Proposed caps, all post-fold:

| block                    | rows | which rows |
| ------------------------ | ---- | ---------- |
| shell output, settled    | 5    | the tail (pi's `BASH_PREVIEW_LINES = 5`) |
| shell output, live       | 3    | the tail |
| diff at approval         | 12   | head + tail, the middle named |
| error text               | 3    | the head |
| read result, settled     | 0    | the settled row already carries the line count |

### R2 — a live block's height never changes until it settles

A running tool's tail is a **fixed-height window**: 3 rows from its
first frame, blank-padded before output arrives. Streaming deltas
repaint *inside* the window instead of growing the block.

This matters specifically because of parallel tools. `compositor.ts:104`
keeps `#toolCells: Map<callId, cellIndex>`, so a running tool is not
necessarily the last cell — and `render()` re-renders every live cell
each frame (compositor.ts:559). A cell that grows mid-list shifts every
row after it, on every delta. A fixed window makes the height change
exactly once, at settle, which is a discrete event a person can follow.

### R3 — caps are recomputed on resize, and only on resize

pi caches `cachedLines` keyed on `cachedWidth` and invalidates when the
width changes. kiso already has the same seam: the `#fullRedraw` path
re-folds committed cells at the new width (compositor.ts:535, the V6-1
screen-state == frame-state rule). Block caps must ride that path.
Re-measuring per frame is precisely the shape of the frame storm.

### R5 — spacing is a formula, not taste

opencode's rule, from `util/layout.ts` via `InlineToolRow`:

> a row gets one blank line above it when the row is itself a block, or
> when the **previous sibling was taller than one row**.

So consecutive one-row tools pack tight, and anything multi-row breathes
on both sides — automatically, with no per-call decision. kiso currently
emits a blank only after a terminal (`renderTerminalGap`). Adopting the
formula is a few lines in the container and removes every ad-hoc blank.

### R6 — a nested session is bounded like any other block

opencode's `Task` renderer collapses an entire child session to the tool
row plus **one** line:

- while running: `↳ <child's current tool> <title>` — the child's last
  running tool, replaced in place, so the height never changes;
- when done: `↳ 12 tool calls · 34s`.

kiso's `delegate` (`extensions/subagent/src/kiso-subagent.mjs`) already
computes `toolCalls` and `outcome` per section and joins every section's
text into one blob. Today that blob goes to the model and the row on
screen is `✓ delegate (…, 42s)` with nothing under it. The data for
opencode's two-row treatment is already there; only the render is
missing.

### R4 — a cut always names itself, and tool-truncation is a separate fact

Two different things get confused today, and kiso shows neither:

- **the renderer cut** — `└ +240 earlier rows · ctrl+r`
- **the tool cut** — `└ capped by read_file · offset=200 for the rest`

kiso's tools already truncate and already write a continuation note
(`tools-node/src/index.ts`: `OUTPUT_CAP` 100k chars,
`DEFAULT_READ_LINES` 200, `MAX_SEARCH_MATCHES` 50, `MAX_DIR_ENTRIES`
200 — "every truncation carries an actionable continuation note"). That
note reaches the model and **never reaches the human**, because the
settled row renders no result body at all. R4 puts it on screen.

## 7. Field parity with pi and opencode

| field                        | pi | opencode | kiso v6 | v7 |
| ---------------------------- | -- | -------- | ------- | -- |
| shell output preview         | 5 visual rows, tail | 10 lines, **head**, char-budgeted | **nothing on success** | R1 |
| tool-level truncation notice | `Truncated: showing X of Y lines`, `Full output: <path>` | — | **never shown** | R4 |
| renderer-level cut notice    | `... (N earlier lines, key to expand)` | `…` + click to expand | **never shown** | R4 |
| read line range on the call  | `formatReadLineRange` | passes remaining input through | **not shown** — though `read_file` is rangeable | settled row |
| expand control               | `app.tools.expand` per tool | click / `onClick` per block | **none** — only `/last` | `ctrl+r` |
| search match count           | — | `Grep "x" (N matches)` | **not shown** — capped at 50 silently | settled row |
| subagent progress            | — | child's current tool, then `N tool calls · 34s` | **nothing** | R6 |
| spacing rule                 | ad hoc | **a formula** (`util/layout.ts`) | blank after terminal only | R5 |
| diff layout by width         | — | **split above 120 cols, unified below** | unified only | worth taking later |
| post-edit diagnostics        | — | `<Diagnostics>` (LSP) | none | out of scope — needs an LSP |
| syntax highlighting          | `highlightCode` | native `<diff>` + syntax style | out of scope (v2e) | stays out |
| images in results            | kitty / iTerm | yes | none | stays out |
| per-state background tint    | `toolPendingBg` / `SuccessBg` / `ErrorBg` | `diffAddedBg` etc. | none | stays out — tint dies in a pipe |

kiso is **ahead** in two places worth keeping: the settled row carries a
line count (`read foo.ts (912 lines)`) where pi's collapsed read renders
nothing and opencode's shows no count either; and the recap line has no
equivalent in either.

Most of the gaps are one missing piece: **kiso never renders a tool's
result body.** R1, R4 and R6 add it, bounded.

### One place the three disagree, and why v7 picks kiso's side

The left-hand glyph means different things in each:

- **opencode** — the glyph is the **tool**: `→` read, `✱` grep, `$`
  shell, `←` edit, `%` fetch. State goes to a spinner and a color.
- **pi** — no gutter at all; the tool name is bold text, state is a
  background tint on the block.
- **Claude Code and v7** — the glyph is the **state**: queued, running,
  settled, failed, held.

v7 keeps state in the gutter. With twenty rows on screen, the question a
person actually asks is "did anything fail / what is still going", not
"which of these was a grep" — and the tool name is right there in a
5-column aligned field, one glance to the right. Tool-as-glyph also
needs a distinct memorable glyph per tool, which does not survive MCP
servers adding arbitrary tools at runtime.

## What this costs

| piece                       | surface                                  | risk |
| --------------------------- | ---------------------------------------- | ---- |
| banner: lowercase, 2 sizes  | `render.ts` (`LOGO_ROWS`, `bannerLines`)  | low — pure functions, existing gates re-baseline |
| gutter vocabulary           | `components.ts` (each component's glyph)  | low — same line count, same fold |
| tool verb column            | `components.ts` `ToolExecution`           | low |
| the box chrome              | `compositor.ts` `footerLine` + draw paths | medium — two draw paths (`#drawFull`, `#drawSteady`) and the editor's column math |
| collapse: rolled up         | cell model — needs a group key on tool cells | medium — new state, new key binding |
| collapse: folded turn       | cell model — needs a turn boundary        | medium |
| opening screen resume       | `apps/cli/src/index.ts` — reads session meta | low |
| R1 visual-row caps          | `diff.ts` `truncateDiff` + `components.ts`  | medium — the cap needs the width, so it moves into the component |
| R2 fixed live window        | `components.ts` `ToolExecution`             | low — a pad-to-N, no new state |
| R3 cap cache on resize      | `compositor.ts` `#fullRedraw` path          | medium — must not re-measure per frame |
| R4 result body + cut rows   | `components.ts` + the cell's `resultText`   | low — the data is already on the cell |
| R5 spacing formula          | `components.ts` `Container`                 | low — one rule, replaces every ad-hoc blank |
| R6 subagent two-row         | `components.ts` + the delegate result shape | low — `toolCalls`/`outcome` already computed |

The presentation-only pieces land without touching the event stream.
R1–R4 are the flow contract and should land **before** the collapse
rungs — rolled-up and folded rows are a density feature, and density on
top of unbounded blocks just hides the problem instead of fixing it.

## Open questions for the round

1. Box or rails (preview frame 6)?
2. Does the roll-up belong in v7, or in its own round after the
   presentation layer settles?

Settled during the round: the banner art is out (section 1), so there is
no mark question left to answer.

## The review page

`node scripts/tui-v7-preview.mjs --html > review.html` renders all seven
frames from the same definitions the terminal path uses — the page and
the terminal cannot drift. It carries a light/dark terminal toggle,
because the frames have to hold in both.
