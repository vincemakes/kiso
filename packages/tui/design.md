# kiso tui — the design contract

Scope: `packages/tui` and `packages/tui-cells`. Everything drawn on a
terminal by kiso is governed here.

This is not a plan and not a proposal record. It is the standing
description of what the screen is, written so that a later round cannot
quietly reverse it and so that a reviewer can check a diff against
something. **Changing a rule in this file is a decision; code that
contradicts a rule here is a bug.**

Rules are SETTLED unless marked **OPEN**, which means the answer is not
known and the reason is written down. The findings under
`bench/rd1/findings/` carry the arguments; this file carries the
conclusions.

**Graphite (owner-ruled 2026-09-28).** This revision states the screen as
the Graphite rounds build it. It lives on the `tui/graphite` branch with the
rounds and reaches main together with them, so the file and the code agree
on main. A rule that a later round builds says so in its heading — `(R2)`,
`(R3)`, `(with Safe Admission)` — and until that round lands the code keeps
the behaviour the rule replaces.

---

## 1. The laws

**1.1 One hairline.** A single solid rule (`─`) is the only divider the
chrome draws, and it is the same rule everywhere: the composer's two rules,
the edge of the live zone and of a band, the rule under a first-level
heading. Not boxes, not a second weight. A rule is a *delimiter*; a SURFACE
(§1.6) is what contains. Two rules carry colour, and only as a fade along
their length: the composer's top rule (gold at its left end, §7.8) and a
first-level heading's (§7.15). An answer's own section break is content, not
chrome, and renders as `·  ·  ·` (§7.15). The `│` gutter survives only where
it SCOPES — a quote, a diff — never where it separates.

**1.2 Grey chrome, two accents, and words carry every fact.** Frames,
labels, keys and metadata are grey. Two accents exist and each means one
thing:

- **Gold is the edge of a turn:** the person's words (the bar of their
  block), what is live (the twinkle, a running call's
  breath, a message waiting to land), what needs the person (`❯`), the seal
  `✦`, and the input line. Gold never colours the machine's content.
- **Blue is the machine:** a second-level heading, inline code, links, the
  branch name, a call's card.

Outcomes keep their own colours on the outcome WORD only. **Strip every
escape sequence and no fact is lost**: every block that could be taken for
another keeps a mark that is a character, not a colour — the person's words
their `▌` where there is no ground to paint (§7.9), a card its verb, a meta
row its label — and the answer is the one block with none. An outcome is a
word, and an emphasis is never the only carrier of meaning. The one stated
exception is thinking: its mark is its grey italic, which a stripped frame
loses (DC-47's exception, back since 2026-09-29); where colour is off, the
plain word `thinking:` opens it (§7.2).

DECLARED REVERSAL (Graphite, owner-ruled 2026-09-28). This law read "grey
chrome, coloured content" and admitted no accent. The design round admitted
gold and blue, one meaning each. R1 retired the DC-47 exception with a
`THINK` label; the owner removed the label (2026-09-29), and the exception
is back.

**1.3 No empty marks.** A symbol earns its cell by carrying a fact the
words do not. A row that already says `exit 0` does not also need a tick
saying it went fine, so the tick is gone; so is the cross. A gutter is a
mark too: a `│` on a row with no content is the same error one scale
down.

A warning is the same case as the tick: a row that says *deletes files
permanently* does not also need a mark saying it is serious, and the
sentence is what survives `NO_COLOR` (DC-42).

*Known cost, accepted:* a failure has no shape, only a colour, a card
ground and its words. `❯` survives this law because it does not describe an
outcome — it means *you have to do something*.

**1.4 Two marks, one beat.** A running command breathes; a running
thought twinkles. Nothing else in the product moves. See §5. The terminal
title changes with the state and never on a tick (§5.4).

**1.5 Labels are words, upper case; surfaces are backgrounds.** A card's
verb (`READ`, `RUN`, `EDIT`), a meta row's label (`COMPACTED`), a band
row's key (`MODEL`, `SESSION`). They name what a block is; they are never
content, and they are grey (§1.2). A block whose look already says what it
is takes no label: the person's words are their block, thinking is its
grey italic (§7.2), and the answer is what is left.

A surface is drawn with cell BACKGROUNDS — never with block-element glyphs
that must JOIN from row to row (`▄ ▀ █`, or a bar down several rows). A
terminal draws a glyph from the font, and where the line is taller than the
font (Apple Terminal among them) the glyph stops short of the cell's edge:
rows that should join show a seam, a bar drawn down several rows reads as a
dashed line. A background fills its whole cell. So a pad is a whole ROW of
background, a card's edge is one cell of background, and the wordmark's
letters are background cells. A glyph is fine where it has no neighbour to
join. (Measured on the owner's Apple Terminal with seam tests, 2026-09-29:
half-row pads in either orientation, `▌` and `▎` down four rows, a `▐` laid
over a background, and `█` letters all showed seams or ticks; background
rows and cells did not.)

DECLARED REVERSAL (owner, 2026-09-29) of R1's `THINK` label (blue, with
its seconds) and of R1's half-row pads and side bars: both were seen in
the owner's terminal and read as strange (the label) and broken (the
seams).

**1.6 Surfaces, and what each one says.** A surface is a ground painted
behind rows. Each kind says one thing, and nothing is painted to decorate.

- **The person's block — their own words.** A warm ground across the full
  width, with a gold bar in column 0 (§7.9).
- **The card — one call of the machine's work** (§7.4). Its ground is the
  call's STATE: the machine's blue while it runs AND once it has run, red
  when it failed or was refused, gold while it waits for the person. (A
  neutral ground once it succeeded read as a flash: a call that takes a
  tenth of a second went blue, then grey — owner, 2026-09-29. Whether it
  is still running is the mark's and the outcome word's to say.)
- **Code** — a fenced block in an answer, and inline code (§7.15).

Where the ground is not known no surface is painted (§3.1): the person's block
falls back to reverse video, and a card to its indented, unpainted form
(§7.4).

Neither is an emphasis. Nothing is painted to make it stand out.

DECLARED REVERSAL (Graphite, owner-ruled 2026-09-28). Reverse video was the
person's surface on every ground, and one neutral wash was every call's.
The person's block takes the warm ground — reverse video remains only as the
unknown-ground fallback — and the card's ground now carries its state, as
the reference implementation's cards do.

**1.7 One card per call, and nothing folds.** Every call stands in the
transcript as its own CARD (§7.4), at a height that depends on what it did
and on nothing else. Everything the model *says* — its answer and its
thinking alike — stays as words. What keeps a burst of calls from owning
the screen is the preview cap, a constant per call (§7.4), never a
judgement about runs.

This is R13's ruling (2026-09-03) and Graphite keeps it. The design round
considered one card per stretch of work, with one row per call, and did not
adopt it.

**1.8 One content edge, one mark column.** Every block begins at column 2:
prose, thinking, the person's words, a card's contents, meta rows, the
seal's words. Columns 0–1 are the mark column — the seal's `✦`, the
twinkle on a streaming thought's first row, a hanging `§` beside a
second-level heading, the live row's mark, the person's `▌`, a card's edge
and its mark. Surfaces (the person's block, a card) span the full width,
from column 0. The composer has no prompt glyph: the caret stands in
column 0 (§7.8). A block's own internal indents — a list's bullet, a
card's verb column, a diff's sign — are its own.

DECLARED REVERSAL, twice. The Graphite design round (2026-09-28) moved the
edge from column 2 to column 4 to give hanging marks a column of their own.
Seen in the owner's terminal (2026-09-29), column 4 read as too much left
margin, and column 2 came back — the 0.44 geometry — with the marks in
columns 0–1.

---

## 2. The palette

kiso emits 24-bit colour where the terminal says it renders it
(`COLORTERM` is `truecolor` or `24bit`) and the nearest xterm-256 index
otherwise; `/status` names the tier (§8.8). The owner's daily terminal
reports `truecolor` and renders it (Apple Terminal 470.2 on macOS 26,
measured 2026-09-28). The table is Graphite on a white and on a black
ground; §3.4 derives the surfaces from the ground actually resolved.

| token | white | black | role |
|---|---|---|---|
| ink | `#111111` | `#ededed` | answers, targets, the person's words |
| ink2 | `#444444` | `#b5b5b5` | tool output, secondary facts |
| dim | `#646464` | `#8e8e8e` | labels, thinking, keys, metadata |
| rail | `#8c8c8c` | `#6b6b6b` | the mark column's quiet glyphs, cut notes, table lines |
| line | `#e6e6e6` | `#212121` | hairlines |
| wash-run | `#edf2fb` | `#141b28` | a running call's card |
| wash-done | `#f1f1f1` | `#1b1b1b` | a settled call's card; a code block |
| wash-fail | `#fbecea` | `#2a1716` | a failed or refused call's card |
| wash-ask | `#f7f1e3` | `#211d13` | a call waiting for the person; a band's selected row |
| human | `#f7efdc` | `#efe6cf` | the person's block |
| human-ink | `#171923` | `#141620` | text on the person's block |
| gold | `#8a5a00` | `#e3b04b` | edge text |
| gold-mark | `#c9921f` | `#e3b04b` | edge graphics: bars, the caret, `✦`, the fade |
| blue | `#2456b5` | `#82a8f5` | the machine's accent |
| code | `#e4ebf8` | `#1a2438` | the inline-code ground |
| ok / fail | `#2f7a3a` / `#b3261e` | `#8fd19e` / `#f2877a` | outcome words |
| add / del | `#dff0e2` / `#fadfdc` | `#16301f` / `#3a1b1a` | diff rows |
| track | `#e2e2e2` | `#2a2a2a` | the ctx meter's empty cells |

A card's bar takes its state's edge colour: `blue`, `rail`, `fail`, or
`gold-mark`.

Contrast is the WCAG relative-luminance ratio of a token against the
surface it sits on. The floor for anything a human reads is **4.5:1**.

DECLARED REVERSAL (Graphite, owner-ruled 2026-09-28). The palette was
256-colour indices only, "never truecolor", with one wash and a `washDim`
grey measured against it. Both retire with this table.

**2.1 Every text token clears the floor on every surface it can reach,
as shown.** The surfaces include the terminal's own ground. "As shown"
means in the tier actually written: the 256 tier rounds each colour to its
nearest index, and the floor is measured on the rounded colour. On the
reference grounds the weakest pairs are `ok` on `wash-fail` (4.61 on white,
24-bit) and `dim` on `wash-ask` (5.13 on black, 24-bit); the gate also
sweeps the common terminal themes of both kinds in both tiers. A new
surface or a new token is checked against every text token before it
lands; a token that fails on one surface is barred from that surface, not
relaxed.

**2.2 The floor is a floor, including mid-animation.** A mark that
breathes never drops below 3:1 on the surface under it — the floor for a
graphic rather than for text (WCAG 1.4.11). This has shipped wrong once —
index `252` is 1.54:1 on white, invisible.

**2.3 A fixed red is not theme-safe.** ANSI `31` (`#CC0000`) is 5.89:1 on
white but **2.83:1** on a dark ground, so the failure colour is
theme-resolved like everything else in the table.

**2.4 Emphasis is never a background.** To make one token the brightest
thing in a dim run, cancel the dim and add weight — do not paint behind
it. A background reads as a block on an otherwise plain row, and the
property wanted was contrast, not a surface. (§1.6's surfaces are the
exception, and they mean something else.)

---

## 3. The ground

Every rule in §2 needs one fact: **is the terminal light or dark**.
Resolution ladder, first hit wins:

1. `KISO_THEME=light|dark`, then the user config's `theme` — an
   explicit answer always wins, and the environment is the more local of
   the two. USER-level only: a terminal is a property of the person
   sitting at one, not of the repository they have open, so a project
   config carrying `theme` is a LOUD error.
2. **`CSI ? 996 n`** — ask the terminal to REPORT its colour scheme; it
   answers `CSI ? 997 ; 1 n` (dark) or `; 2 n` (light).
3. **OSC 11** — ask the terminal for its background colour, compute
   luminance.
4. `COLORFGBG` — set by some terminals, absent on many.
5. **Reverse video** — theme-free by construction. Heavier, never wrong.

Rungs 2 and 3 are two different questions and rung 2 is the better one:
the terminal's own account of its scheme outranks a ground kiso infers
from a colour it was handed. Both are asked in one write at startup,
neither is waited on, and when both answer and agree the screen is
repainted once.

**Rung 2 has never been seen to answer.** Measured 2026-09-03: Apple
Terminal 470.2 returns nothing to `CSI ? 996 n` within 1.5s, answers
OSC 11 in the same window, and is unaffected by the two sequences
sharing one write — no crosstalk, no cost. It is kept because it is
free and because it asks the better question of any terminal that does
implement it; it is recorded as unproven because no terminal available
here implements it.

**3.1 The LAST rung is the safety property, not a leftover.** When the ground is
unknown kiso does not guess a surface; it uses the mark that is correct on
any ground. The design degrades; it never renders light-mode paint on a
dark screen.

**3.2 The ladder runs whether or not the terminal answers.** The
environment rungs are resolved before either query and again with each
reply, so a terminal that answers nothing still gets `KISO_THEME`, the
config's `theme` and `COLORFGBG` (DC-14). Only rungs 2 and 3 are
contingent. Apple Terminal answers rung 3; the wider survey across
terminals is still not done, which is why rung 2 was added and why rung
1 is persistable — between them, a terminal that reports nothing is a
setting away from a resolved ground rather than a dead end.

**3.3 kiso does not guess.** Where nothing answers and nothing is set,
the ground stays `unknown` and the design degrades (§3.1) — it does not
default to dark and hope. The reference implementation makes the other
choice; the cost of guessing wrong is light-mode paint on a dark screen,
or a full-width surface that is the wrong colour on every row of a card,
and a settled default is indistinguishable from a resolved one to
everything downstream. The persisted `theme` is the answer for a
terminal that reports nothing.

**3.4 Surfaces are derived from the resolved ground.** §2's table is
Graphite evaluated on `#ffffff` and `#0b0b0b`. When OSC 11 reports any other
ground of the same kind, each surface is computed from it — per channel, an
affine map fitted so that the two reference grounds give the table exactly —
so a terminal whose black is `#1e1e1e` still separates its cards from its
ground. A text token that would then fall under the floor, on the ground or
on a surface, as shown (§2.1), moves toward the kind's extreme — lighter on
a dark ground, darker on a light one — just far enough to clear it; on the
reference grounds nothing moves. If a pair still fails, the table is used.
When the ground is resolved without a colour (rungs 1, 2 and 4), or the
reported colour is of the other kind than the resolved ground, the table's
own column is used.

---

## 4. The marks

| mark | means |
|---|---|
| `●` | a call is running — in its card's mark cell; it breathes (§5) |
| twinkle (§5.2) | the model is working — on the live row for the whole turn, and in the mark column of a streaming thought's first row |
| `❯` | it needs you: an approval, a question, an unknown outcome to decide |
| `◇` | a message the person sent that has not landed yet |
| `◌` | an outcome kiso cannot know: a call started and no result was recorded |
| `↻` | a retry is counting down |
| `✦` | finished and on disk: a turn's seal; with tasks, a finished task |
| `§` | a second-level heading, hanging in the mark column |
| `▌` `▎` | the person's block's bar; a card's bar |
| `▾ ▸ │` | the transcript viewer's marks (§9) |
| (none) | a settled call — its outcome is in the words |

**4.1 One mark, one meaning, everywhere.** A mark that means two things
is worse than two marks.

*One DECLARED EXCEPTION (owner-ruled 2026-09-28).* In the terminal title
`✦` means the session is working (§8.10). The title has no seal for it to
be confused with, and the owner chose the kiso mark for the tab that is
busy.

**4.2 A settled call wears no mark.** A card's mark cell is empty once the
call settles: the outcome word says what happened and the card's ground
says the state. A mark left lit after the motion stops is §1.3's empty
mark.

**4.3 `❯ ask pending · answers are durable facts`.** The pending panel
states its own durability, and it is the only line in the interface that
can: kill the process, come back, the question is still here and the
answered ones are not asked again.

---

## 5. Motion

**5.1 The cadence is the spinner tick.** `SPINNER_MS` is 200ms; seven
steps is **1.4 seconds**. Both animations are seven frames, so the frame
cadence and the byte volume of a waiting screen do not change.

**5.2 The two cycles.**

```
command   ● gold, seven steps of brightness: peak → floor → peak
thinking  ✧ → ✦ → ✶ → ✸ → ✺ → ✸ → ✦, in gold
```

The command breath is **brightness only** — one glyph, seven steps from
`gold` toward the running card's ground, the floor being the deepest step
still at 3:1 on it (§2.2). The thinking twinkle is **glyphs only**, so it survives
`NO_COLOR` while the breath correctly freezes to a static `●`. When the
thought ends the twinkle leaves; the `✦` that stays on screen is the turn's
seal (§7.11), not the thought's.

**5.3 A breath says alive; a turn says counting.** A call whose duration
cannot be predicted gets no mark implying progress it does not have, so
neither animation rotates — and a mark lit while nothing moves is the
same error. One that is gone before the eye lands is not a mark at all,
which is why the breath rides the activity and not each call (§7.3).

**5.4 The title does not move.** The terminal title changes when the state
changes (§8.10) and never on a tick: a ticking title churns tab bars and
screen readers, and §1.4 leaves the product two moving marks.

---

## 6. Glyph budget

The renderer may only use glyphs the terminal's font actually has.
Measured against Menlo, macOS's terminal default:

- **Available:** quadrant and shade blocks, eighth bars, box drawing,
  circles and arcs (`· • ● ○ ◎ ◉ ◦ ∘`), triangles, diamonds, the star
  family, arrows.
- **Absent:** the finer legacy block sets (sextants, octants). They
  render as empty boxes; no macOS system font supplies them.
- **Braille** (`U+2800`–`U+28FF`) is NOT absent — measured on the real
  terminal 2026-09-02, correcting what this section used to say. Apple
  Terminal's default Menlo falls back to Apple Braille and draws solid
  dots. It is still unusable for a raster: the dot pitch does not divide
  the cell height, so a densely tiled image shows horizontal banding.
  Rasterising a mark through it reads at 12×6 cells and up and turns to
  dominoes below 10×5 — the same threshold R2 measured for block
  characters. Rejected on looks, not on availability.

**6.1 Emoji-capable glyphs are forbidden in chrome.** A glyph present in
Apple Color Emoji may be drawn coloured and **double-width**, tearing a
row whose width was computed as one cell. `✳` (`U+2733`) and `✴`
(`U+2734`) are the two a star ramp reaches for first, and both are in
that font — which is why the twinkle uses `✧ ✦ ✶ ✸ ✺`. Check the emoji
font's table before adopting any new symbol.

**6.2 Ink area is the size axis, not the code point.** A ramp is ordered
by measured ink. At 60px in Menlo: `·` 72, `✧` 144, `•` 235, `✦` 248,
`✶` 311, `○` 364, `✸` 536, `✺` 566, `●` 1014.

**6.3 The rule is gated, not merely written.** The chrome's glyph set is
checked against Apple Color Emoji's coverage, pinned as data so the gate
runs off macOS too. Measuring the width table instead answers a
different question — the table is kiso's own opinion, and this rule is
about the terminal's. Graphite's glyphs — `◇ ◌ ↻ ▌ ▆ ⋯ § ✓ ○ ›` and
the wordmark's `█ ╗ ╔ ╝ ╚ ═ ║` — lie outside that table (checked
2026-09-28) and join the gated set.

---

## 7. The turn on screen

A turn is thinking, work, and an answer. §7 says how those three occupy
rows, and it is the part of this file the rest of the product is most
easily broken against: **the screen must not move under the reader.**

**7.1 Committed rows are final WITHIN a rendering.** A row that has
entered the terminal's scrollback is never re-emitted, reflowed or
erased by the frame path. One act stands outside the frame path: a
SETTLED RESIZE, and `ctrl+o`, which is the same act. Either erases the
terminal's screen and scrollback (`2J H 3J`) and reprints the session
from the model at the current geometry, so the terminal holds exactly
one rendering of the record (ADR-0046 Amendment 1).

DECLARED REVERSAL (R14, 2026-09-05). This section used to end "so kiso
cannot expand anything in place after the fact — an expansion appends",
and §7.7, §9.0b and the whole append apparatus were downstream of that
sentence. R10 measured the old rule on the owner's terminal and it did
not hold up: kiso already erased the visible screen at launch (DC-40), a
grow lost 16 rows (DC-39), a narrow duplicated four tokens, and the
scrolled-off transcript never reflowed at all. The seam is not
removable under the old rule, because the scrollback is the terminal's
and `3J` is the only instruction that rewrites it.

What is still true, and is what this section is for: **the screen must
not move under the reader.** A reprint is not motion under the reader —
it is the same record, redrawn whole, at the geometry the reader is
now looking at.

**7.2 Thinking is words.** The model's thinking renders as its own block:
`dim` italic paragraphs at the content edge, folded by WORD like every
prose surface, a blank line between paragraphs, shown in full. It carries
no label — its grey italic is what tells it from the answer (§1.5). While
the model thinks, the twinkle hangs in the mark column of the block's first
row; settled, the column is empty. With colour off there is no grey and no
italic to tell it by, so there — and only there — its first row opens with
the plain word `thinking:`. It closes the current stretch rather than
joining one: what the model says is not work.

`ctrl+t` hides every thinking block to one dim row
(`thinking · hidden · ctrl+t`) and shows it again; the choice is
remembered, and shown is the default for every model. A turn with no
thinking text has no thinking block at all — kiso does not announce a
thought it cannot see; whether a provider sends thinking text is the
provider's side (a GPT model sends summaries only when asked for them).

DECLARED REVERSAL (owner, 2026-09-29) of R1's `THINK <seconds>` label in
blue, which read as strange; R1 also folded thinking by character, which
broke words mid-way.

A PIPE never sees a thinking paragraph: the inactive path writes one
folded summary line (`foldThinking`).

**7.3 A running call is the same card, and it GROWS.** A call with
nothing back yet is the card a settled call with no output is: its head
row. Each line of output adds a row, to five; past five the cut
note appears above a scrolling tail and the card grows by that one row,
once. Nothing pads a window — the height is the content.

**The settle never shrinks it.** That is what makes a settle a change of
content and nothing else: the ground stays the machine's blue unless the
call failed or was refused (§1.6), the breathing mark leaves its cell, and the head
row's right end that said `running · 3s` says `exit 0 · 90 lines · 3.2s`.
The shell's gestures ride that same row rather than spending a window row
on a footer. The one row a settle may add is the foot row (§7.4), and only
when the card has rows behind the key.

The live region as a whole is bounded by the SCREEN, and the window's
top never falls: within a rendering, rows that have reached the
terminal's scrollback are immutable (§7.1 — a reprint starts a NEW
rendering and is not bound by this), so the paint may not go back above
them, and a live region that grows scrolls committed rows away rather
than reclaiming any. Where the room is tight a window may not GROW past
it, and below the card's smallest body a call keeps its head row until it
commits (DC-43). A window that already grew is never pulled back in.

**A turn in flight with an empty live region says so.** One row —
`thinking…`, dim italic at the content edge, no glyph — stands where the
model's first words will, so whatever arrives replaces it in the same
column and the same font and the eye sees a word change rather than a
jump: thinking text turns it into the thinking block, an answer replaces it
and leaves nothing behind. It is NOT a cell: it never commits, never reaches the scrollback, and
neither `/last` nor the pipe has heard of it. That is what makes a row
which is a guess about the future permissible at all — a row that never
becomes history cannot make history wrong.

A card that only grows is what DC-46 measured on the a7 replay: 8.9 / 13.5
/ 3.5 percent hole-frames, against 16.9 / 24.6 / 7.9 for a card that
shrank at its settle.

**7.4 A settled call is a CARD.** One object, one shape, every call:

```
▌                                                              pad: a row of the card's ground
▌ SHELL   npm test -- recovery          exit 0 · 90 lines · 4.1s
▌ … 85 earlier lines
▌ <the last five output rows>
▌                                                 ctrl+o expands
▌                                                              pad
```

(`▌` here stands for the card's EDGE: one cell of its ground deepened toward
the state's colour, drawn as a background.) The card spans the full width,
on its state's ground (§1.6), with a whole row of that ground above and
below it (§1.5). Two cards are one blank row apart, like any two blocks.

The columns: the edge cell at 0, the head's mark cell at 1 (§4), the verb
at 2 — the content edge — the target at 10, and the BODY at 2, UNDER THE
VERB: the head and what it printed line up (owner, 2026-09-29, the 0.44
card's alignment). The HEAD row: the verb, the target, and at the right
the outcome (§7.5). The BODY, when there is one, is the preview in `ink2`
— five rows at most. A shell shows its TAIL with the cut
note above it, because the conclusion of a command is at the bottom of its
output; everything else shows its HEAD with the note below, because that is
where its answer is. **A read shows nothing at all**: its result is the
file, five lines of it tell a reader less than the head row already does,
and the key opens the whole thing. Its continuation note, when the tool
itself capped the result, is not a preview and stays. The FOOT row carries
the key, right-aligned, and exists only while something is behind it: on a
collapsed card when the preview cut rows away, on an expanded one when
collapsing would hide rows again. A call with nothing to preview is its
head row between its pads — and when its result sits behind the key (a
read), the key ends the head row's outcome instead: `412 lines · 0.1s ·
ctrl+o expands`.

**An EXPANDED card is the same card** — the whole body, uncapped, and
`ctrl+o collapses` on its foot row when there is anything to collapse.
One skeleton in both states, so the global switch (§7.7) changes a card's
content and never its shape.

An edit's body is its diff (§7.14), capped at twelve rows — a stated
exception to the five-row preview, because five rows cut most diffs in
half.

**Where the ground is NOT known the card does not paint at all.** Rung
5's surface is reverse video (§3), and one inverted row is the ladder
working while eight inverted output rows are a black slab in the middle
of the transcript. Unpainted, the head row sits at the content edge, the
body four columns under it (column 8) with `└` opening it at column 6, and
the rows dim. The CONTENT is the same either way — only the surface is
contingent. The indent carries a §1.2 fact — these
rows are the call's output, not something the model said — which is why it
is an indent and not a glyph: it survives a pipe.

DECLARED REVERSAL (Graphite, owner-ruled 2026-09-28). The card was
`pad · head · blank · preview · blank · outcome · pad` at column 2, one
neutral wash for every state, the outcome on a row of its own and whole
blank rows as pads. The outcome now rides the head row, the key rides a
foot row that exists only when needed, the ground is the state, and the
card sits at the content edge (§1.8). One card per call (§1.7) is
unchanged. R1 drew half-row pads and a side bar with block glyphs; they
retired (owner, 2026-09-29) for the seams they left (§1.5).

**7.5 A card reads verb · target, then outcome.** The verb is the tool's
display verb in upper case (`SHELL`, `READ`, `EDIT`, `WRITE`, `LIST`,
`SEARCH`), `dim`, padded to seven columns so the targets line up; the
target is `ink`. The outcome sits at the right end of the head row: what
happened, how much of it there was, how long it took — `exit 0 · 90 lines ·
4.1s`. A running call's reads `running · 12s`, with the shell's gestures
after it while there is room. Only the outcome WORD takes colour — `exit 0`
in the success colour; `exit 1`, `failed`, `denied` in the failure colour —
which is §1.2 exactly: the colour rides the fact, not the object carrying
it. The card's ground says the state as well, and the word still says it
alone.

A failure's outcome word is short and its text is the body: a shell's
`exit N`, any other tool's `failed`. A refusal reads `denied by you ·
<reason>` when the person refused and `denied · <reason>` when a policy
did (VD-11: the person's answer is worth recording; the ambient default is
not).

The head row gives way in a pinned order when the width squeezes: the
attribution first, then the count; then the target elides in its middle;
then, on a very narrow row, the target goes, then the verb, then the
outcome's segments from the front — so how long it took, and the key where
there is one, are the last to go. The foot row's key is RESERVED — a card
that says how much is hidden without saying how to see it is the silence
the affordance exists to remove. No row of a card ever folds; it is cut.

Only a call still running carries a mark, because only it is moving.

**7.6 Deleted (R13, 2026-09-03).** It read: *a folded stretch is one
line, and prints no key*. Nothing folds (§1.7), so there is no line for
it to govern. Kept as a numbered stub because §7's numbers are
referenced from the code and from the findings record.

**7.7 `ctrl+o` is one switch, and every settled card obeys it.**
Pressing it flips a single state and reprints the session (§7.1): every
card whose content is SETTLED renders expanded — the whole body, and
`ctrl+o collapses` on its foot row — or collapsed, which is the preview and
`ctrl+o expands`. A card whose content is still ARRIVING is exempt: its
height is E2/DC-43's, and a global "show everything" has no business
reaching into it. A card parked for approval is settled, not arriving — its
diff is complete and a human is reading it — and that is exactly when the
key must answer.

DECLARED REVERSAL (DC-50 / R14, 2026-09-05). This section used to read
"`ctrl+o` has exactly one target and says which. The row it will act on
renders its own `ctrl+o` token at full strength among dim siblings —
exactly one bright token per frame." The one-bright-token rule existed
because the key had ONE target and the reader had to be told which; with
no target to name, the rule has nothing left to protect and retires with
it. The per-card affordance stays — it is true of every card, which is
what makes the switch legible without a bright token to single one out.
D-S2-1 (owner-ruled 2026-09-06): the status bar names the switch,
`ctrl+o expand all` / `ctrl+o collapse all`, shown only while some card on
screen has something behind the key.

**7.8 The composer is four rows and stays four rows.** `CHROME_ROWS` is
4: the top rule, the input, a hairline, the status bar (§8.9). Every gate
keyed on `H − 4` depends on it. The top rule is `gold-mark` for its first
eighth and fades to `line` by a third of the width. There is no prompt
glyph: the caret is a block in the terminal's own ink (reverse video) and
the text starts at column 0. *(R2)* While the line starts with
`!`, the prompt is `$` (§7.13). The live zone (§8.7) sits above these four
rows and is not part of them. The line-mode prompt (no composer: a terminal
kiso does not dock in) is unchanged.

While the input is empty it shows nothing: `?` lists the keys, and the
empty row is kept for later work to speak in (follow-up suggestions).
DECLARED REMOVAL (owner, 2026-09-29) of R1's key ladder placeholder.

DECLARED REVERSAL (Graphite, owner-ruled 2026-09-28). R2 (owner,
2026-08-27) ruled that the docked composer has no prompt glyph: the rules
already said "input lives here", and a glyph cost the row a column. The
design round brought back a gold `›` and a gold caret; the owner, seeing
them (2026-09-29), took both out again — R2's ruling stands, with 0.44's
caret.

**7.9 The person's words span the width.** The person's block (§1.6): the
`human` ground across the full width with a whole row of it above and
below (§1.5), an EDGE cell of gold quieted toward the warm ground in column
0 down every row, and the text at the content edge, column 2. The edge is a
background, the same width as a card's edge: a thinner `▌` glyph, or a `▐`
laid over a gold background, showed a gap or a tick at every row in Apple
Terminal (checked there, 2026-09-29). No label and no time: the block says whose words these are, and when a turn
ended and how long it took is the seal's (§7.11). The block is padded to
`W` by *display* width, so a CJK row pads correctly, and it folds by WORD:
the character fold was defended as lossless, which is not a property CJK
has, and every other prose surface already folds by word. A word wider than
the row still breaks mid-word, because an overflowing row breaks invariant
①. Where the ground is unknown the `▌` stays in column 0 as a character
and the block is reverse video from column 1 (§3.1).

*(R2)* On a terminal, each of the person's blocks is wrapped in OSC 133
prompt marks, so a terminal that supports them can jump between the
person's messages; the marks are invisible elsewhere and never reach a
pipe. They are written by the compositor as it emits the block's first row,
not carried inside the row: a row that carried them would have to teach
every width measure, cut and screen model to skip an OSC, and the marks
would follow the row into the ctrl+r viewer.

*(R2)* The text renders as markdown (§7.15) in the block's own colours, so
pasted code and lists keep their shape.

DECLARED REVERSAL (Graphite, owner-ruled 2026-09-28). The words were
reverse video on every ground with a two-column inner pad; the design round
chose the warm ground with a gold bar. R1 drew half-row pads with glyphs
and put the text at column 4; the owner saw the seams and the indent in
Apple Terminal (2026-09-29), and the pads became whole rows of background
and the text moved to column 2.

**7.10 The opening.** The wordmark, then what loaded.

```
██╗  ██╗██╗███████╗ ██████╗
██║ ██╔╝██║██╔════╝██╔═══██╗
█████╔╝ ██║███████╗██║   ██║
██╔═██╗ ██║╚════██║██║   ██║
██║  ██╗██║███████║╚██████╔╝
╚═╝  ╚═╝╚═╝╚══════╝ ╚═════╝
─────────────────────────────
the coding agent that survives kill -9 · <version>
intent → effect → durable fact
```

The block cells take `mix(ink, dim, row / 4)`, top to bottom; the
box-drawing shadow takes `mix(rail, ground, 0.35)`; the rule under it fades
from `dim` to the ground. No gold: gold is the edge (§1.2), and the opening
has none. `<version>` is the CLI's own package version, never a literal.

Beside the wordmark when `W ≥ 96`, behind one hairline, what loaded, one
fact per row — the label `dim` in its column, the fact in `ink`, a
quieter note after it:

- `SESSION` — `new · resumable after kill -9`, or `resumed · N events`;
- `RULES` — the instruction file the prompt reads (the same lookup, so it
  never names a file the model is not given), or `none`;
- `SKILLS` — the count, and how many cannot load;
- `MCP` — servers and tools, `connecting…` while they are;
- `EXTENSIONS` — the same extensions line a pipe prints, so the two never
  disagree about what loaded (and `ask (off in dontAsk)` stays beside the
  tier that turns it off);
- DC-49's home-directory row, when the workspace is the home directory.

The model, the mode and the folder are the status bar's (§8.9) and are
not repeated. Under 96 columns the facts move below the wordmark. The
wordmark shows from 20 rows — in the 80×24 window a Mac opens by default
(owner, 2026-09-29: a wordmark the default window never shows is not worth
drawing). Under 20 rows, on a terminal
too narrow for the wordmark at the content edge, and on a resume (the
history is above the opening there, and ten rows of wordmark would bury
its tail) the head is one line —
`✦ kiso <version> · the coding agent that survives kill -9` — and the
facts follow it. A fact that does not fit loses its note; one still too
long hangs under itself, folded by word — an extensions list cut at the
width would hide which extensions loaded, on the one screen whose job is
to say so. Beside the wordmark only while the folded facts fit its six
rows.
The letters are cells of BACKGROUND, not `█` glyphs (§1.5): in Apple
Terminal `█` left a white line through every row of the letters. Where the
ground is unknown there is no background to paint, and the wordmark is `█`
in the terminal's own foreground.

The R2 keys row retires: `?` lists the keys (§8.5).

The opening scrolls the shell's screen away first: H line feeds from
the shell's cursor carry its prompt, the launch command and the tail of
what ran before into the scrollback as content, and the first frame
then owns rows 1..H. What was on screen is one scroll up, not gone
(DC-40). The feeds precede the entry reset, because `ESC[r` homes the
cursor and feeds after it scroll one row instead of the shell's r.

DECLARED REVERSAL (Graphite, owner-ruled 2026-09-28). This section read
"No logo. The name is the mark": a rendered wordmark cost rows the first
screen needed for its three questions — what model, where am I, what is
loaded. The design round brought a wordmark back and moved the answers: the
model and the folder to the status bar, what is loaded to the block beside
the wordmark. The cost is ten rows, once, at the top of a session.

**7.11 The seal.** After every turn, one row — today's turn line,
restyled: `✦` in `gold-mark` hanging in the mark column (§1.8), the words
`dim` at the content edge.

```
✦ took 4.1s · fresh 1.3k out 910 · cache 96%
```

It is the turn's record in the scrollback: how long it took, what it cost
in fresh and output tokens, and the cache share, so a turn's cache miss stays
findable after the status bar has moved on. No turn number, no call count and
no context share (owner, 2026-09-28): the first two do not help the person
reading, and the context lives on the status bar's meter (§8.9).

The other forms keep their words: a cache miss adds `miss <n>` after the
cache share; a cold cache reads `cache cold after <n> min · re-read <n> ·
out <n>`; plan mode reads `plan ready · /mode default executes · /mode
accept-edits auto-approves edits`; a turn the person stopped reads
`stopped by you after 6.2s`, then the same facts. The row is cut, never
folded (R3g). The pipe keeps today's bytes.

**7.12 kiso's own sentences are meta rows.** The session's events —
compaction, a pruned result, a learned window, a run that failed after its
retries, an uncertain outcome, a limit reached, an interrupted stream, the
verification pass — are sentences about the session, not the model's and
not a tool's. Each is one row at the content edge: a bold label
(`COMPACTED`, `PRUNED`, `WINDOW`, `FAILED`, `UNCERTAIN`, `LIMIT`,
`INTERRUPTED`, `VERIFY`) in a twelve-column label column, and the sentence
beside it, folded under itself (column 14). `FAILED` and `UNCERTAIN` name
outcomes and take the failure colour; the rest are `dim`. No card and no
ground: they are not the machine's work.

A command's own confirmation — `mode → plan`, `model → …`, `[/compact] …`,
`[dontAsk] …` — has no kind of its own: its words are read as a whole, and
a label would only split them. It stays whole at the content edge, with no
label. On the terminal the `✦` some notices open with comes off: it is the
seal's mark (§4). A pipe prints every notice as written.

**7.13 The person's own shell (R2).** `!command` runs and sends;
`!!command` runs and only shows. It renders as a card whose verb is `$` and
whose target is the command, and whose outcome says `sent to the model` or
`not sent` — the one fact that differs between the two.

**7.14 An edit shows its diff (R2).** Every `edit_file` and `write_file`
card shows what it changed, in every approval mode. The diff is built from
the call's own hunks — `search` is the old text, `replace` the new — which
the log holds, so the card renders the same live, after a reprint and after
resume; nothing is read from the file and no request byte changes. It
appears when the call's arguments are complete, before the file is written;
the outcome reads `applying`, then `edited` or `refused · <reason>`.

- A line-level LCS per hunk; unchanged lines inside a hunk are context
  (`dim`); a sign column, then the text.
- One `−` line followed by one `+` line: the changed words take a stronger
  mix of their row's colour.
- The hunks of one call are separated by a `⋯` row, and the head says
  `N hunks`.
- Twelve rows, then `… +N lines · ctrl+o expands`.
- The approval panel shows the same diff uncapped, for every hunk of a
  batch edit (`edits`), not only for a single `search`/`replace`.
- `write_file`: a new file shows its first five lines as `+` rows and
  `new file · N lines`; an overwrite shows the new head, because the old
  content is not in the log.
- No line numbers (§10).

**7.15 The answer's markdown (R2).** The answer carries no label (§1.5); it
is the prose at the content edge, rendered as:

| element | rendering |
|---|---|
| `#` | bold `gold`, then a rule fading from `gold-mark`; only an answer's first `#` takes it, and a later one renders as `##` |
| `##` | bold `blue`, `§` hanging in the mark column |
| `###` | bold `ink` |
| `####` | bold `dim`, upper case |
| bold / italic / strike | bold ink / italic / `dim` with SGR 9 |
| inline code | `blue` on `code` |
| link | `blue`, underlined; an OSC 8 hyperlink where the terminal supports one, the URL in `dim` after the text where it does not |
| bullets / ordered / tasks | `–` then `·` / `1.` in `dim` / `✓` ok, `○` dim |
| quote | italic `ink2` behind a `dim` bar |
| alerts | `NOTE`: a `blue` bar and label; `WARNING`: a `gold-mark` bar and label |
| table | light box drawing in `rail`, the header row bold |
| code fence | a `wash-done` block with its bar and the language at the top right; keywords `blue`, strings `ok`, numbers `gold`, comments `dim` italic, function names bold |
| rule | `·  ·  ·` in `rail` |

Prose, thinking and the answer wrap from the content edge to two columns
short of the right edge — the same margin on both sides, and no width cap
(owner, 2026-09-29: a 92-column cap left the words far short of the cards
beside them on a wide terminal).

---

## 8. Around the input

Everything that sits directly above or below the input. Above it: the
BANDS — the command list, the `@` picker, the session picker, the pending
panel, `/status`, `/settings`, the model picker — and the live zone (§8.7).
Below it: the status bar (§8.9). The terminal title (§8.10) is the input's
state seen from another tab. The keys sheet is the band vocabulary on the
body.

**8.1 A band names itself.** It opens on the hairline, then its title row:
the title bold gold — `commands`, `files`, `sessions`, `keys`, `needs you`,
`status`, `settings`, `model` — and its keys at the right. With scrollback
behind it, nothing else says where the surface begins.

**8.2 A band is a WINDOW, not the whole list.** Five rows and a
counter — and the counter appears only when the list is actually cut,
because over rows you can all see it says nothing they do not. Rows
are a table: the name column padded to the longest entry in the WHOLE
list so the descriptions do not shift as the window scrolls, and a
long description CUT rather than folded, since a fold would break the
height the window buys. The selected row is on `wash-ask` with the gold bar
and a gold `›`.

**8.3 A band opens on its sigil.** `/` alone opens the command list;
the list that names the commands must not require you to name one
first. The rows do not repeat the sigil — it is on the input line
directly below them.

**8.4 Enter completes; the NEXT enter sends.** The same rule for every
band. Completing and sending on one key would send a fragment. `esc`
closes every band.

**8.5 What gives way, and where the keys are advertised.** A piece
skipped is an affordance lost at a width that could have shown it, so
everything that can drop drops WHOLE, in an order set by how findable the
key is WITHOUT the hint.

The status bar (§8.9) gives way, in order: the `ctrl+o` hint, the folder
(the terminal title names it too, §8.10), the branch, the model's middle
(elided, DF-0330-F1), and last `/mode to switch` — it stays for as long
as it fits: it is the one place a newcomer meets modes. The facts — the
mode, `floor off`, the model, ctx, cache, tok/s — never drop; past them
the row is invariant ①'s to cut.

The key ladder (`/ commands · ↑ history · ctrl+r transcript · @ files ·
? keys`) that R1 put in the empty input retired with the placeholder
(§7.8, owner, 2026-09-29): `?` opens the keys sheet, and `/` opens the
command list. The status bar's `/mode to switch` is the one teaching hint
left on screen, which is why it is the last thing the bar gives up.

**8.6 The editor's keys, and the one gesture with three spellings.**
`alt+←/→` moves the cursor by word and `alt+⌫` / `alt+d` delete a word
back and forward; `ctrl+x` copies the last answer. A WORD is decided
once, by one function five operations share: whitespace and the
newline separate; punctuation and alphanumerics separate FROM EACH
OTHER, so `foo.bar` is three words; a CJK character is one word on its
own, because a sentence is not a unit anyone wants to step through. A
combining mark, a ZWJ join or a variation selector never ends a word —
they belong to the character before them, so an emoji is deleted whole
rather than dismantled. The ideographic space (U+3000) is a SEPARATOR,
not a character, even though it sits inside the CJK range.

**This is not a grapheme-cluster segmenter, and the gap is larger than
it looks.** Measured: `👍🏽` and a flag each delete in one press — correct,
but by accident, because an emoji and its modifier both fall in the same
"punctuation" class and form one run rather than because anything knows
they are one glyph. The same accident makes `😀😁` delete BOTH in one
press, which is wrong. Skin-tone modifiers and regional-indicator pairs
are not joiners. A real segmenter is the fix and is not in this
round.

The word gestures arrive in three encodings (`alt+←`, `ctrl+←`, and
`alt+b`/`alt+f` where the terminal sends meta) and all three reach the
same code. **A terminal that sends none of them has no word motion, and
there is no probe and no fallback** — `ctrl+w` is listed beside them in
the sheet because it works everywhere. Alt gestures are recognised
SAME-CHUNK only, following KC2 §2's ruling for `alt+⏎`: a lone `\x1b`
is a bare Esc and fires at once, and Esc's immediacy is worth more than
joining a split pair.

**A pasted TAB is kept, and shown as `→`.** The buffer holds the real
U+0009, so the submitted line and the durable record carry the
indentation the human pasted; the composer shows a one-cell `→` in its
place. It has to: a terminal expands a tab to the next tab stop while
kiso measures it as one cell, so a painted tab makes the row on screen
wider than the row kiso computed — invariant ① — and every cursor column
after it drifts by the same amount.

One cell rather than an expansion, because **a tab's width is a property
of its position** and the width layer answers per code point with no
context; CJK's two cells work because two is a property of the
character. **The declared cost:** a pasted block's alignment in the
composer is approximate, while the block itself is exact. A TYPED Tab is
unchanged — it completes in the menu and the `@` picker, and inserts
nothing.

The clipboard says only what it knows: `copied N chars` where a real
`pbcopy` reported an exit status, `asked the terminal to copy N chars`
where the route was OSC 52 (a request the terminal need not honour and
most do not answer), and nothing at all — no escape emitted — when
stdout is not a terminal.

**8.7 The live zone.** Rows directly above the composer that exist only
while something is live, with no rule of their own (owner, 2026-09-28):
the composer's top rule is right below them, and one blank row above them
keeps the streaming words off the live row (owner, 2026-09-29). Otherwise the input sits
against the transcript. The LIVE ROW: the mark in the mark column, the state
and its facts, the keys at the right; hints drop from the right when the row
is short.

`working` stands for the whole turn, from its start to its end, whatever the
model is doing — thinking, writing, waiting on a call. It never switches to
"thinking": what the model thinks is in the stream (§7.2), and a row that
guessed would be wrong for a model that shows no thinking. The other states
replace it while they last.

| state | row |
|---|---|
| working | `✸ working 12.4s · ↓ 1.2k · 48 tok/s` |
| retry | `↻ retrying 3/10 · <what failed> · next try in 4s`, and `esc gives up` |
| compacting | `✸ compacting · 18s`; *(R3)* with its reason: `manual`, `past the soft tier`, `overflow` |
| waiting *(R3, with the panels)* | `❯ needs you · <what>`; until then the open panel's own status holds the status row |

The keys while a turn runs: `esc stop · ⏎ queue · alt+⏎ redirect`. A queued
message is one row: `◇ queued  <text>  after this turn · ↑ edit`.

*(with Safe Admission, owner-ruled 2026-09-28)* `⏎` during a run is STEER,
and there is no queue. A steer waits as
`◇ steer  <text>  lands after this step · ↑ edit` until the runtime admits
it — after the current tool batch settles, in the same run — and then
stands in the transcript where it landed: the gold bar without the warm
ground, and `steer · landed after <step>` in `dim` at the right end of its
first row. Several steers sent before
one admission point land together as one message. A turn stopped with a
steer still waiting puts its text back in the input. The queued row and
`alt+⏎` retire with the queue.

**8.8 The panels (R3).** `/status`, `/settings` and the model picker are
bands (§8.1–8.4), and `esc` closes each.

- `/status` is read-only: SESSION, MODEL (the full id and the endpoint),
  CONTEXT (the meter, where the window figure comes from, the split
  system / tools / history / this turn, the soft and hard tiers), CACHE,
  TOKENS, COLOUR (24-bit or 256), VERSION.
- `/settings`: one row per setting — `name · value · source` (user,
  project, env or default); `↑↓` move, `←→` change.
- The model picker: `/model`'s list as a band; `⏎` switches.

**8.9 The status bar.** One row under the input: the session and its
health.

```
default  /mode to switch  deepseek-v4-flash · max  ctx ▆▆▆▆▆▆▆▆▆▆ 9%  cache 92%  48 tok/s     main  ~/code/kiso
```

- The mode as a chip — `plan · read-only` for plan, bypass in `fail`; then
  `floor off` in `fail`, only when the floor is off.
- `/mode to switch` (§8.5).
- The model and its effort, elided in the middle when short (DF-0330-F1).
- The ctx meter: ten `▆` cells, the used share filled and the rest in
  `track`, then the percentage used. Filled cells are `ink2` below the soft
  compaction tier, `gold` from the soft tier to the hard one, `fail` past
  the hard tier, read from the runtime's tiers (`tiersFor`) and never from
  a fixed fraction. There is no marker inside the bar: the tier shows as
  colour only (owner, 2026-09-28). The cells follow the percentage SHOWN:
  `ctx 0%` is an empty meter, and from 1% at least one cell is filled;
  otherwise cells round to the nearest (owner, 2026-09-29 — a lit cell
  beside `0%` read as a contradiction). `ctx ?` when the window is
  unknown, with no meter.
- `cache NN%` and the last settled call's `NN tok/s`, each only once
  measured.
- At the right: the branch in `blue` (read from `.git/HEAD`, a detached
  HEAD as its short sha, nothing outside a repository), the folder, and
  `ctrl+o expand all` / `ctrl+o collapse all` while a card has rows behind
  the key (§7.7).
- The words are quiet (`dim`): only the chip, the meter's cells, the
  branch and `floor off` carry colour. Off a known ground the chip is
  `▸ <mode>`, the segments join with ` · `, and each side is one dim span.

Nothing reserves a place for what has not shipped. With background tasks,
`● N tasks running ↓` joins the bar; an extension's status joins its right
side once extensions can set one (§10).

**8.10 The terminal title.** OSC 0, written only when stdout is a TTY:

```
<name> — <folder>                      ready: no mark
✦ <name> — <folder>                    working
❯ needs you · <name> — <folder>        an approval, a question, an unknown outcome to decide
```

The name is the one `/name` set *(R3; durable in the session log, and the
name the resume picker and `kiso sessions` show)*, else the first
substantive input (`sessionTitle`), else there is none and the title is
`kiso — <folder>`. Working is a turn or a `/compact`; needs you is any
panel that waits on the person's answer (an approval, an ask, the trust
gate, an uncertain execution), and the answer puts back what the title
said before. No model writes the title. It changes when the state
changes and never on a tick (§5.4). No bell and no notification: nothing
interrupts the person (owner, 2026-09-28). The text is escaped and stripped
of bidi and invisible formatting code points, and the name is cut at 40
cells. On exit kiso writes the ready form, so a closed session never leaves
a working or waiting mark behind.

---

## 9. The transcript viewer

`ctrl+r` opens a reader over the turn's record. It was born because §7.1
made expand-in-place impossible; R14 makes it possible, and the viewer
stays anyway, because the two answer different questions. `ctrl+o`
changes how the transcript is PRINTED — it is still the transcript,
still scrolled through the terminal's own scrollback. `ctrl+r` opens a
SURFACE with its own cursor, its own paging, and its own rendering at
today's width, for walking back through a session that is longer than
anything printing can help with. Both exist; neither does the other's
job (DC-41).

**9.0 Which key, and why this one.** The viewer held `ctrl+o` from
0.19.0 to 0.20.4, on the bet that a borrowed key transfers muscle
memory. It transfers the key and betrays the action: elsewhere `ctrl+o`
expands the tool output in front of you, which is §7.7's job, not this
one — reported from real use (DC-41). So `ctrl+o` is the expand key and
the viewer takes `ctrl+r`. No control key was free of a collision
somewhere; `ctrl+r` is the cheapest, because what it displaces
elsewhere is renaming a session, which kiso does with a command (`/name`,
§8.10) and not a key. The viewer fires only on an idle, empty composer, so
the collision can only ever land where the other product's binding is
itself a no-op.

**9.0b The `ctrl+o` expansion is the CARD ITSELF, re-rendered.**
DECLARED REVERSAL (DC-50 / R14, 2026-09-05). This section described an
APPENDED card whose head row named the call it opened — `shell curl … ·
expanded · 2 turns back` — because a block that lands wherever the
bottom happens to be needs to say which call it is a copy of. Amendment
1 removes the copy: the card is re-rendered where the call stands, so
the addressing retires with the thing that needed addressing. What
survives unchanged is the part that was never about appending — the body
is the WHOLE result, uncapped, because an expansion that capped would be
no expansion.

**9.0c The viewer and the switch coexist, and a reprint closes the
viewer.** A reprint is a commit storm and nothing commits while the
viewer is up (§9.2), so a settled resize — or a `ctrl+o` — closes it
first. The reader reopens it: one keypress, stated here rather than
discovered.

**9.1 It lives on the PRIMARY screen.** No alternate screen — it is a
second, divergent world to keep correct, and it takes the viewer's rows
away on exit along with anything printed while it was up. The keys
sheet is the precedent: an overlay that leaves nothing behind.

**9.2 While it is up, nothing commits.** The window is frozen at its
pre-open position and no line feed is emitted, so the viewer displaces
content *on screen* and the close restores every displaced row.

**9.3 The cursor is the keyboard's.** `↑↓` move, `⏎` toggles, `a` toggles
all, `esc` closes. The marks are `▾` open, `▸` the cursor on a closed
row, `│` a body row — and `▾` does not depend on where the cursor is,
because a mark that vanishes when you look away is not a mark.

**9.4 The mouse is out of scope.** Click and hover would mean taking
over the terminal's own selection, and the cost is the user's copy and
paste everywhere.

---

## 10. Open

- **The wider terminal survey** (§3.2). Apple Terminal answers OSC 11
  and does NOT answer `CSI ? 996 n` (measured 2026-09-03); every other
  terminal is unmeasured, and rung 2 has therefore never been observed
  answering anywhere. It bounds how often the ground resolves in the
  field — no longer how often it CAN, since §3's rung 1 is persistable
  now. **Re-probing mid-session** (a terminal that announces a scheme
  change while kiso is running) is owed and not built.
- **What the a7 replay's remaining holes are.** DC-46 closed by making
  the running card grow rather than shrink, and the hole rate came back
  to 8.9 / 13.5 / 3.5 percent — at or below where 0.23.0 sat. The
  expectation was BELOW at every size, since both of 0.23.0's sources
  (the act slot's release, the fold) are retired; two of three landed
  exactly on it. So the residual is something older that this round did
  not touch and did not measure.
- **A per-call title.** Naming what a call is *for*, in the model's own
  words, would mean the model authoring it — a request-byte change and a
  different release tier, not a visual round. §7.2's visible thinking
  already carries the narration at no schema cost, which is the reason
  this stays open rather than planned.
- **Rows per turn.** Labels, the seal and the half-row pads add rows to
  every turn. R1 measures a fixed scenario before and after and sets a
  ceiling here; no compact density is planned.
- **Narrow widths.** The grid is stated for 64 columns and up. R1 walks
  W 20..200 and writes the narrow forms of the card, the live row and the
  status bar here.
- **Extension messages and status.** Extensions have no message surface
  and cannot set a status; §7.12's row and §8.9's right-side slot are the
  intended forms, and the surface needs an ADR.
- **Line numbers in diffs.** They need the tool's result or a display-only
  field in the log; neither is decided, and diffs carry none.
- **Images.** No inline images.

---

## 11. Amending this file

State the rule as it now stands, in the present tense, and delete what
it replaced. This file is the contract, not its history — the arguments
live in `bench/rd1/findings/` and the commits.

A change must say what became true, so a reader can tell a decision from
a drift, and must leave the file consistent: a rule the code contradicts
is a bug in one of them, and this file does not get to be the stale one.

A change that overturns a standing ruling names it — `DECLARED REVERSAL`,
the ruling, and why — in the section it changes.
