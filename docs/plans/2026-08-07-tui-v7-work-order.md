# TUI v7 — implementation work order

Companion to `2026-08-07-tui-v7-design.md` (the rationale). This file is
the executable half: what to build, in what order, which files, what
counts as done, and which gates each item breaks.

**Status: nothing implemented. `packages/tui/src` is untouched by this
round.** The only artifacts are this file, the design doc, and
`scripts/tui-v7-preview.mjs`.

**Baseline: 0.1.35** (`abb5097`). The v6 rework round-2 fixes (the
W-blind `≤100` ThinkingFold crash, the commit-anchor 2B, the live-line
row placement, and the three re-baselined gate scripts) are already in
and are NOT part of this work order.

---

## 0. See the target before writing code

```
node scripts/tui-v7-preview.mjs                    # colored, your width
node scripts/tui-v7-preview.mjs --plain            # zero SGR — the pipe contract
node scripts/tui-v7-preview.mjs --width 64         # the narrow check
node scripts/tui-v7-preview.mjs --html > out.html  # the review page
```

Eleven frames, one definition, two renderers — the ANSI path and the HTML
path cannot drift. Frame numbers are referenced by the work items below.

---

## 1. Constraints no item may break

1. **Zero ANSI in pipes and `NO_COLOR`.** Byte-checked by the e2e gates.
   Colour and reverse video are emphasis; **structure carries meaning**.
   Every frame must read at full strength with the palette off — check
   `--plain` first, always.
2. **Invariant ①** — every emitted line's visible width ≤ W or the
   compositor throws. Everything folds. Every emitted line already
   passes `#checked(line, W)` (compositor.ts:812); keep it that way.
3. **`CHROME_ROWS` stays 4.** The live-region geometry and every gate
   keyed to `H − 4` depend on it. W6 changes what the four rows *are*,
   never how many.
4. **`charWidth` (editor.ts) is the width authority.** Every new glyph
   below classifies as width 1. Do not introduce a glyph it would call
   width 2 without checking.
5. **Never re-measure per frame.** Width-dependent work rides the
   `#fullRedraw` path (compositor.ts:535). Per-frame re-measurement is
   the shape of the frame storm.

---

## 2. Decisions already made

| # | decision |
| - | -------- |
| D1 | Banner stays. Uppercase. BIG 36x6 as default, COMPACT = v6's existing rows unchanged. |
| D2 | Pictorial ring (logo.svg in cells) is rejected — reads as a hexagon at 3 rows. |
| D3 | Gutter carries **state**, not tool identity (opencode does the opposite; see design doc §7). |
| D4 | Tool metadata sits in parentheses, not in `dim` — it must survive `NO_COLOR`. |
| D5 | Sent user message gets reverse video, **inset chip** cut. Input box unchanged. |
| D6 | Flow contract (W7–W12) lands **before** the collapse ladder (W13–W15). |

## 3. Open decisions — these block the items named

| # | question | blocks |
| - | -------- | ------ |
| O1 | Box chrome or keep v6's rails? (preview frame 6) | W6 |
| O2 | Do rungs 3–4 of the collapse ladder belong in v7 at all? | W13, W14 |
| O3 | **Resolved: W15 stays in release 3** (0.1.38, with W6) per the round ruling. Release 1 ships the `ctrl+r` affordance; the append semantics land with W15 — the live-region toggle works from day one, the committed-cell append arrives with the key's full contract. | W7, W10 |

Everything else can start today.

---

## 4. Work items

Each item: **what · files · spec · done-when · gates hit**.

### W1 — Banner: uppercase, two sizes

- **Files**: `packages/tui/src/render.ts` (`LOGO_ROWS`, `bannerLines`),
  `apps/cli/src/index.ts` (caller, if the row budget changes).
- **Spec**:

  BIG (36x6, `█` and space only — no half-blocks, so there is no tile
  seam to lose in a font that renders `▀ ▄` at the wrong height):

  ```
  ██    ██  ██████  ████████  ████████
  ██  ██      ██    ██        ██    ██
  ████        ██    ████████  ██    ██
  ████        ██          ██  ██    ██
  ██  ██      ██          ██  ██    ██
  ██    ██  ██████  ████████  ████████
  ```

  COMPACT — v6's existing `LOGO_ROWS`, **byte-identical, no redraw**:

  ```
  █ █ ▀█▀ █▀▀ █▀█
  █▀▄  █  ▀▀█ █ █
  ▀ ▀ ▀▀▀ ▀▀▀ ▀▀▀
  ```

  Selection, extending the existing "under 40 columns, skip the logo"
  rule — note this adds a **height** input `bannerLines` does not take
  today:

  | terminal | banner |
  | -------- | ------ |
  | ≥ 40 cols and ≥ 20 rows | BIG |
  | ≥ 40 cols and 14–19 rows | COMPACT |
  | anything smaller | text rows only |

  Each pixel is two cells wide **on purpose**: a terminal cell is about
  1:2, so one-cell pixels render a 4x6 capital at 1:3. Do not "fix" the
  doubling.

  The text row under the art does **not** repeat the name — the art is
  the wordmark. It reads `v0.1.32 — the coding agent that survives
  kill -9`, then the model/cwd/extensions row.

- **Done when**: all three tiers render at 40, 64, 88 and 120 columns
  with no row exceeding W; BIG needs 38 columns including its 2-column
  indent, so it clears 40.
- **Gates hit**: `apps/cli/tests/banner.test.ts` asserts the literal
  `"█ █ ▀█▀ █▀▀ █▀█"`. It stays valid for COMPACT; add BIG coverage.

### W2 — One gutter column

- **Files**: `packages/tui/src/components.ts` (every component).
- **Spec**: every transcript row opens with a one-cell gutter.

  | gutter | meaning | weight |
  | ------ | ------- | ------ |
  | `▍` | you spoke | bold |
  | (none) | kiso spoke — content is the default | plain |
  | `⋯` | thinking, folded to one row | dim |
  | `◦` | tool queued | dim |
  | `▖▘▝▗` | tool running (v6's existing spinner) | bold |
  | `✓` | tool settled | bold |
  | `✗` | tool failed | red |
  | `⏸` | tool waiting on you | bold |
  | `▞` | a header in kiso's voice | bold |
  | `│` | a bounded block's body, owned by the row above | dim |
  | `└` | that block's last row: what was cut, where the rest is | dim |

  `◦` replaces `→` for **queued specifically** because `·` is the
  separator inside every metadata group; a queued marker that is also
  the separator glyph reads as noise.
- **Done when**: the left edge alone distinguishes all states at
  `--plain`.
- **Gates hit**: `tui-v2a.test.ts` (`▞`), `tui-v2e.test.ts` (`✓ …`).

### W3 — The verb column

- **Files**: `packages/tui/src/components.ts` (`ToolExecution`).
- **Spec**: pad the tool verb to 5 columns so target paths line up:

  ```
  ✓ read  packages/tui/src/compositor.ts (912 lines, 0.2s)
  ✓ edit  packages/tui/src/compositor.ts (+9 -4, 0.1s)
  ✗ shell npm run lint (exit 1, 0.9s)
    └ compositor.ts:712 — prefer-const
  ```

- **CAUTION — the two render paths disagree today.** The compositor
  path uses the **raw** tool name (`components.ts:247`,
  `escapeTerminal(c.name)` → `edit_file`), while the pipe path strips
  the suffix (`render.ts:280`, `name.replace("_file", "")` → `edit`).
  The 5-column verb assumes the stripped form, so the component must
  strip too — which **changes** what the compositor prints.
- **Done when**: both paths print the same verb.
- **Gates hit**: `tui-v2e.test.ts:115` pins `"✓ edit_file"` on the
  compositor path. It must be re-baselined to `"✓ edit"` — this is a
  deliberate behaviour change, not an accident.

### W4 — Metadata in parentheses

- **Files**: `packages/tui/src/components.ts`.
- **Spec**: settled-row metadata reads `(912 lines, 0.2s)` /
  `(+9 -4, 0.1s)` / `(exit 1, 0.9s)`. Do not rely on `dim` to separate
  it — that separation vanishes in a pipe.
- **Done when**: `--plain` output is unambiguous.

### W5 — Opening screen: the resume list

- **Files**: `apps/cli/src/index.ts`.
- **Spec**: under the banner, a `▞ resume` header and up to 2–3 recent
  sessions: relative time, title, then right-aligned
  `N events · M runs`. Every field already exists behind
  `renderSessionLine` / `kiso sessions`. Drops entirely below the
  COMPACT threshold.
- **Rationale**: the reference spends this space on "what's new"; kiso
  survives `kill -9`, so it spends it on what you can pick back up.
- **Done when**: the right-hand meta column is aligned across rows.

### W6 — The chrome — **BLOCKED ON O1**

- **Files**: `packages/tui/src/compositor.ts` (`footerLine`,
  `#drawFull`, `#drawSteady`), `packages/tui/src/editor.ts` (column
  math only).
- **Spec** (if the box wins): the two `╌` rules become a rounded box;
  still four rows.

  ```
  ╭──────────────────────────────────────────────────────────╮
  │ › fix the resize repaint                                 │
  ╰──────────────────────────────────────────────────────────╯
  ready · deepseek-v4-flash                / commands · ↑ history
  ```

  Inside the box the prompt goes light (`›` instead of v6's `▌`) — the
  box already says "input lives here".
- **Notes**: the cursor keeps deriving from `CURSOR_MARKER`; borders are
  only a prefix width, so marker handling is unchanged. The line-mode
  path (`editor.ts:219`) keeps `▌ `, so **pipe bytes do not change**.
- **Gates hit**: `tui-v6-idle-chrome.test.ts` (`"╌"`, `"▌ "`,
  `"/ commands · ↑ history"`), `tui-v6-livecap.test.ts` (`"╌"`, `"▌ "`),
  `scrollback-flood.test.ts` (`"▌ "`), `tui-v2a.test.ts` (`"▌ "`),
  `banner.test.ts` (`"▌ "`). This is the widest blast radius in the
  round — do it as its own commit.

### W7 — R1: caps counted in SCREEN rows, after the fold, at the current width

- **Files**: `packages/tui/src/diff.ts` (`truncateDiff`),
  `packages/tui/src/components.ts`.
- **The bug, measured not asserted**: `truncateDiff` caps at
  `MAX_DIFF_LINES = 40`, but that counts `DiffLine` entries, and
  `ToolExecution` then pushes each through `foldLine`, which can turn
  one entry into three rows. A realistic 60-line TS edit:

  | width | source lines after truncateDiff | actual screen rows |
  | ----- | ------------------------------- | ------------------ |
  | 120 | 37 | 37 |
  | 80 | 37 | **73** |
  | 60 | 37 | **73** |

  On a 44-row terminal the content cap is `H − 4 = 40`, so that approval
  diff force-commits ~33 rows into scrollback inside one frame.
  Reproduce with the snippet in §6.
- **Spec**: caps, all counted post-fold:

  | block | rows | which rows |
  | ----- | ---- | ---------- |
  | shell output, settled | 5 | the tail |
  | shell output, live | 3 | the tail |
  | diff at approval | 12 | head + tail, middle named |
  | error text | 3 | the head |
  | read result, settled | 0 | the settled row already carries the count |

  Tail for shell (the conclusion is at the end); head for read and
  search (the answer is at the start). pi does tail
  (`truncateToVisualLines`, `BASH_PREVIEW_LINES = 5`); opencode does
  head with a character budget (`collapseToolOutput`, 3 and 10) — and
  its budget miscounts CJK, which kiso must not copy because
  `displayWidth` is right there.
- **Consequence**: the cap needs W, so it moves **into** the component.

- **The shapes** (preview frame 11 — a row count alone is not a spec).
  A 12-row diff is head + tail with the middle **named**, never a silent
  gap:

  ```
  ⏸ edit  packages/tui/src/compositor.ts
    │ 706   const menuRows = this.#menuRows(W);
    │ 708 - let liveLines: string[] = [];
    │ 708 + const liveLines: string[] = [];
    │ 709   for (const cell of this.#cells.slice(...)) {
    │ ⋯ 19 rows
    │ 744   out.push(`\x1b[1G\x1b[0K...`);
    │ 745 - out.push(`\x1b[1A...`);
    │ 745 + out.push(`\x1b[2A...`);
    └ 31 rows total · ctrl+r · /last for the full diff
  ```

  `⋯` is reused from the gutter table (it already means "folded away"),
  so the elision needs no new glyph.

  A 3-row error takes the **head**, because a stack's first frame is the
  one that matters:

  ```
  ✗ shell npm run lint (exit 1, 0.9s)
    │ compositor.ts
    │   712:8  error  'menuTop' is never reassigned  prefer-const
    │   744:1  error  unexpected console statement    no-console
    └ +11 rows · ctrl+r
  ```

- **Done when**: at W=60 and W=120 no bounded block exceeds its row cap.
- **See also**: W15 (what `ctrl+r` can actually do) and W17 (narrow
  widths). Do not implement the `└ … ctrl+r` affordance before reading
  W15 — on committed cells it appends, it does not toggle.

### W8 — R2: a live block's height never changes until it settles

- **Files**: `packages/tui/src/components.ts` (`ToolExecution`).
- **Spec**: a running tool's tail is a **fixed-height window** — 3 rows
  from its first frame, blank-padded before output arrives. Streaming
  deltas repaint *inside* the window instead of growing the block.
  Height changes exactly once, at settle.
- **Why it matters here specifically**: `compositor.ts:104` keeps
  `#toolCells: Map<callId, cellIndex>` for **parallel tools**, so a
  running tool is not necessarily the last cell — and `render()`
  re-renders every live cell each frame (`compositor.ts:559`). A cell
  that grows mid-list shifts every row after it on every delta.
- **Done when**: a faux run with two parallel tools, one streaming,
  produces no row movement below the streaming cell between frames.

### W9 — R3: caps recomputed on resize, and only on resize

- **Files**: `packages/tui/src/compositor.ts` (`#fullRedraw` path).
- **Spec**: cache the folded/capped block per width; invalidate when the
  width changes. pi does exactly this (`cachedLines` keyed on
  `cachedWidth`); kiso already has the seam at `compositor.ts:535`.
- **Done when**: frame count during a steady stream is unchanged from
  0.1.35; a resize re-measures once.

### W10 — R4: render the result body, and name every cut

- **Files**: `packages/tui/src/components.ts`, using the cell's existing
  `resultText`.
- **Spec**: two *different* facts, two rows, never conflated:
  - the **renderer** cut — `└ +240 earlier rows · ctrl+r`
  - the **tool** cut — `└ capped by read_file · offset=200 for the rest`
- **Why**: kiso's tools already truncate and already write a
  continuation note (`packages/tools-node/src/index.ts`: `OUTPUT_CAP`
  100k chars, `DEFAULT_READ_LINES` 200, `MAX_SEARCH_MATCHES` 50,
  `MAX_DIR_ENTRIES` 200 — "every truncation carries an actionable
  continuation note"). That note reaches the model and **never reaches
  the human**, because the settled row renders no result body at all.
- **Done when**: a truncated read and a truncated shell each show which
  kind of cut happened and how to get the rest.

### W11 — R5: spacing is a formula

- **Files**: `packages/tui/src/components.ts` (`Container`).
- **Spec**, taken from opencode (`util/layout.ts` via `InlineToolRow`):
  > a row gets one blank line above it when the row is itself a block,
  > or when the **previous sibling was taller than one row**.

  Consecutive one-row tools pack tight; anything multi-row breathes on
  both sides. Replaces every ad-hoc blank; kiso currently emits one only
  after a terminal (`renderTerminalGap`).
- **Done when**: no component decides its own spacing.

### W12 — R6: a nested session is bounded like any other block

- **Files**: `packages/tui/src/components.ts`, and the delegate result
  shape in `extensions/subagent/src/kiso-subagent.mjs`.
- **Spec**: collapse a child session to the tool row plus **one** line:
  - running: `└ <child's current tool> <target>`, replaced in place so
    the height never changes;
  - settled: `└ 12 tool calls · 3 roles · 0 failed · /last for the report`.
- **Why**: `delegate` already computes `toolCalls` and `outcome` per
  section and joins every section into one blob. Today that blob goes to
  the model and the screen shows `✓ delegate (…, 42s)` with nothing
  under it. The data exists; only the render is missing.

### W13 — Collapse rung 3: rolled up — **BLOCKED ON O2**

- **Files**: the cell model (a group key on tool cells) + `components.ts`.
- **Spec**: when one turn issues N > 2 calls of the *same* tool, collapse
  to one row plus `└` children. This is Claude Code's `groupToolUses`
  (`src/utils/groupToolUses.ts`: group by `message.id`, only for tools
  that opt in, skipped entirely in verbose mode). Group by the assistant
  message that issued the calls.

  ```
  ✓ read  5 files (2.4k lines, 1.1s)
    └ compositor.ts · components.ts · render.ts
    └ +2 more — ctrl+r expands
  ```

### W14 — Collapse rung 4: folded turn — **BLOCKED ON O2**

- **Files**: the cell model (a turn boundary) + `components.ts`.
- **Spec**: a whole quiet turn, once it is scrollback, becomes
  `▞ thought 19s · 5 reads · no edits`.

### W15 — The expand key — **read this before implementing W7/W10**

- **Files**: `packages/tui/src/editor.ts` (keybinding), `components.ts`,
  `apps/cli/src/index.ts` (the append path).
- **The collision.** Every earlier draft of this work order wrote
  "`ctrl+r` expands" as if it were a toggle. On this compositor it
  cannot be, for committed content:
  - `#commitCell` (compositor.ts:599) emits a cell's lines and adds them
    to `#committedLines`;
  - `#committedLines` is the input to `liveTop`
    (`min(#committedLines, H − liveRowsTotal) + 1`, compositor.ts:576);
  - the emitted bytes are in the terminal's **native** scrollback and
    never move — ADR-0046's whole point (zero `\x1b[3J`, zero replay).

  So changing a committed block's height desyncs the frame's geometry
  from what is actually on screen. pi and opencode can toggle anything
  because they are alt-screen with a scrollable virtual buffer; kiso is
  not, and must not become one to get this feature.

- **Spec — expansion is TWO different operations:**

  | target | behaviour |
  | ------ | --------- |
  | a cell still in the **live region** | toggle in place; the compositor still owns those rows and redraws them |
  | a cell already **committed** | **append** a fresh expanded block as new content at the bottom, headed `▞ expanded · <tool> <target> · N turns back` |

  Appending is the idiom kiso already has — `/last`
  (`editor.ts:73`, "show the most recent tool call's input and output")
  works exactly this way. `ctrl+r` is `/last` aimed at a chosen cell
  rather than the newest one.

- **Rule this encodes**: *history is never rewritten.* If an
  implementation ever needs to change the height of a committed cell,
  the design is wrong, not the compositor.
- **Done when**: expanding a tool from three turns back prints a new
  block at the bottom and the rows above it are byte-identical to
  before.

### W17 — Narrow-width behaviour of the caps

- **Files**: `packages/tui/src/components.ts`.
- **The gap**: W7's caps are in screen rows, so at a narrow width a
  12-row diff cap may hold only ~4 source lines once each folds to
  three rows. Undefined until now.
- **Spec**: the cap is a **row budget, not a line budget** — it stays
  12 rows at every width; what shrinks is how much diff fits. Below
  a floor of 3 source lines visible, drop to the head only and let the
  `└` row carry the rest, rather than showing a head and tail so short
  they are noise.
- **Done when**: the same diff at W=120, 80 and 60 never exceeds its row
  budget and never renders a head/tail pair shorter than 3 source lines
  total.

### W16 — The sent user message: reverse video

- **Files**: `packages/tui/src/components.ts` (`UserMessage`).
- **Spec**: **SGR 7**, closed with **SGR 27** (not SGR 0, so it composes
  with a surrounding bold/dim span). SGR 7 inverts against the
  terminal's own two colours, so a light terminal paints dark-on-light
  and a dark terminal paints the reverse — with no theme detection and
  no configured palette. An explicit black background would be wrong on
  half of all terminals.

  Cut: the **inset chip** (D5) — fold first, then pad every row to the
  longest row plus one space each side, indented two. Not the full-width
  band: on a short message like `/think` a full-width band paints a bar
  across the whole terminal for one word (preview frame 10, last block).

  **The `▍` rail stays.** SGR 7 is an SGR, so pipes and `NO_COLOR` drop
  it; the rail is the structural fallback that survives a pipe. The
  block is emphasis on top, never the only marker.

  `foldLine` already reopens an open SGR span after a break, so a
  wrapped chip keeps its paint on continuation rows. What `foldLine`
  does **not** do is pad — the component must, or the block gets a
  ragged right edge.

  **Do not combine SGR 7 with SGR 2 (dim).** Reverse video swaps the
  *current* foreground and background, so dimmed text inverts into a
  dimmed block and loses most of its contrast. The chip is plain or
  bold, never dim.

  A terminal row is exactly one cell tall with no leading, so
  consecutive reverse-video rows tile with no seam — nothing to solve on
  this side. (The HTML preview needed a 1px pad on `.rv` to fake that,
  because a CSS background only paints the inline box and the 1.5px of
  line-height leading showed through. That is a preview artifact and is
  commented as such in the script.)
- **Scope**: the sent message only. **The input box does not change.**
- **Done when**: every chip row has identical visible width; nothing
  exceeds W; `--plain` shows the `▍` rail and zero escapes.

---

## 5. Ordering

1. **W7, W8, W9, W10** — the flow contract. Do this first. Rungs 3–4 are
   a density feature, and density on top of unbounded blocks hides the
   problem instead of fixing it.
2. **W1, W2, W3, W4, W16, W11** — presentation. No event-stream changes.
   W3 carries a deliberate behaviour change; give it its own commit.
3. **W5, W12** — the two "data already exists, render is missing" items.
4. **W6** — chrome, once O1 is answered. Own commit; widest gate blast
   radius.
5. **W15** — the expand contract. It is a PREREQUISITE, not a
   follow-up: W7 and W10 both render a `ctrl+r` affordance, and on a
   committed cell that key appends rather than toggles. Settle the
   semantics before shipping the affordance, or Release 1 ships a key
   that is dead on everything but the last few rows.
6. **W17** — narrow-width cap floor.
7. **W13, W14** — only if O2 says yes.

## 6. Gates that will need attention

Grep-verified against the tree at 0.1.35:

| gate | asserts | hit by |
| ---- | ------- | ------ |
| `apps/cli/tests/banner.test.ts` | `"█ █ ▀█▀ █▀▀ █▀█"`, `"▌ "` | W1, W6 |
| `apps/cli/tests/tui-v6-idle-chrome.test.ts` | `"╌"`, `"▌ "`, `"/ commands · ↑ history"` | W6 |
| `apps/cli/tests/tui-v6-livecap.test.ts` | `"╌"`, `"▌ "` | W6 |
| `apps/cli/tests/scrollback-flood.test.ts` | `"▌ "` | W6 |
| `apps/cli/tests/tui-v2a.test.ts` | `"▌ "`, `"▞"` | W2, W6 |
| `apps/cli/tests/tui-v2e.test.ts` | `"✓ edit_file"` | **W3 — deliberate re-baseline** |

**Gate-gap warning, inherited from round 2**: the faux scripts behind
storm / idempotence / livecap historically contained only `text_delta`
events, which is why every gate stayed green while the real terminal
crashed on a thinking block. Any new gate for W7/W8 must feed the event
type it actually claims to cover — thinking blocks, parallel tools,
streaming shell output — or it proves nothing.

### Reproducing the W7 measurement

```js
const { truncateDiff } = require("./packages/tui/dist/diff.js");
const { foldLine } = require("./packages/tui/dist/components.js");
const diff = Array.from({ length: 60 }, (_, i) => ({
  kind: i % 2 ? "+" : "-",
  text: "\t\tconst someReasonablyLongIdentifier" + i +
        " = await doTheThing(argumentOne, argumentTwo, { option: true });",
}));
const capped = truncateDiff(diff);
for (const W of [120, 80, 60]) {
  let rows = 0;
  for (const d of capped) rows += foldLine(`  ${d.kind} ${d.text}`, W).length;
  console.log(W, capped.length, "->", rows);
}
```

## 7. Explicitly out of scope

| item | why |
| ---- | --- |
| syntax highlighting in results | out of scope since v2e; both references have it |
| images in results (kitty / iTerm) | pi and opencode have it; kiso has no need yet |
| per-state background tint | pi's `toolPendingBg` etc. — a tint dies in a pipe, which breaks constraint 1 |
| post-edit LSP diagnostics | opencode's `<Diagnostics>`; needs an LSP |
| split-vs-unified diff by width | opencode switches at 120 cols; genuinely good, but after W7–W12 |
| the pictorial ring mark | D2 |
