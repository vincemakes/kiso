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

---

## 1. The laws

**1.1 One hairline.** A single solid rule (`─`) is the only divider on
screen, and it is the same rule everywhere: the composer, every panel's
open and close, the band headers, the markdown rule. Not boxes, not a
second weight. A rule is a *delimiter* and a box is a *container*; the
`│` gutter survives only where it SCOPES, never where it separates.

**1.2 Grey chrome, coloured content.** Frames, labels, keys and metadata
are dim ink and never coloured. Colour appears only inside content: diff
signs, and a failure. **Strip every escape sequence and no fact is
lost** — which is why an outcome is words, an emphasis is never the only
carrier of meaning, and output rows are distinguishable from prose in
plain bytes.

**1.3 No empty marks.** A symbol earns its cell by carrying a fact the
words do not. A row that already says `exit 0` does not also need a tick
saying it went fine, so the tick is gone; so is the cross. A gutter is a
mark too: a `│` on a row with no content is the same error one scale
down.

A warning is the same case as the tick: a row that says *deletes files
permanently* does not also need a mark saying it is serious, and the
sentence is what survives `NO_COLOR` (DC-42).

*Known cost, accepted:* a failure has no shape, only a colour and its
words. `❯` survives this law because it does not describe an outcome —
it means *you have to do something*.

**1.4 Two marks, one beat.** A running command breathes; a running
thought twinkles. Nothing else in the product moves. See §5.

**1.5 Labels are mono, uppercase, dim.** `MODEL`, `WORKSPACE`. They mark
sections. They are never content.

**1.6 Two surfaces, and they mean different things.** **Reverse video
is the HUMAN'S surface** — their own words, at full contrast. It
inverts whatever the terminal is, so it is the same weight on a light
ground, a dark one, and one that was never established: one form, no
ladder, nothing to under-read. **The wash is the MACHINE'S surface** —
*this is the machine's work: what was run, and what came back*: inline
code, and every settled call. A lighter ground is right there, because
those rows are read as content rather than heard as an utterance.

*Amended R13 (2026-09-03), reversing the narrowing of 2026-09-02.* The
wash was the machine's VERBATIM surface, and the reading was exact — a
row like `read loop.ts · 412 lines` is kiso's summary of a result, not a
line of it, so it got no surface. What that produced was a page where
some calls are cards and others are loose rows, which is the instability
the reversal is about: the reader cannot predict what the machine's work
will look like. The surface says WORK. One register, one form.

Neither is an emphasis. Nothing is washed, and nothing is inverted, to
make it stand out.

**1.7 One rhythm, one surface: nothing folds and nothing is one-lined.**
Every settled call stands in the transcript as its own CARD (§7.4), at a
height that depends on what it did and on nothing else. Everything the
model *says* — its answer and its thinking alike — stays as words.

*Amended R13 (2026-09-03), owner-ruled.* This law used to read "work
folds, words do not", and four mechanisms implemented it: the segment
fold (R3b–R3i, W14), the W13 rollup, TUI2-R1 (B)'s exploration row and
VD-5's one-row settle. Each answered the same pressure — ungrounded
output rows owned the screen, so work was collapsed into sentences ABOUT
the work. The card changes that arithmetic: a call's rows sit inside a
surface that says where it begins and ends, so five of them read as one
object rather than five loose lines, and the collapse costs more than it
buys. What keeps a burst from owning the screen now is the preview cap —
five rows a call, and none at all for a read — which is a constant per
call rather than a judgement about runs.

**1.8 One left edge.** Prose, the human's words and a card's rows all
begin in column 2. The registers are told apart by SURFACE (§1.6), and
the column is not one of the things doing that work. A block's own
internal indents — a list's bullet, a fence's rail — are its own.

---

## 2. The palette

kiso emits 256-colour indices, never truecolor.

| token | light | dark | contrast |
|---|---|---|---|
| body | terminal default | terminal default | — |
| dim | `243` `#767676` | `246` `#949494` | 4.54 / 5.50 |
| wash (bg) | `255` `#EEEEEE` | `236` `#303030` | 14.55 / 10.20 |
| washDim | `241` `#626262` | `247` `#9E9E9E` | 5.26 / 4.93 *(on the wash)* |
| failure | `#A8442B` | `#E08A6B` | 5.95 / 6.36 |
| added / removed | `32` / `31` | `32` / `31` | — |

Contrast is the WCAG relative-luminance ratio of the token against its
ground (dark measured against `#1E1E1E`). The floor for anything a human
reads is **4.5:1**.

**2.1 Nothing dim ever sits on the wash.** `#767676` on `#EEEEEE` is
3.91:1 and `#949494` on `#303030` is 4.35:1 — both under the floor.

A washed surface that carries metadata still wants it quieter than the
content it annotates, and the answer is not to relax the floor: it is
**`washDim`**, a second grey measured against the WASH rather than
against the ground. `dim` remains barred from the wash exactly as
above — this is a different token with a different job, the way `warn`
was the mono ruling's own set gaining its missing member. With no
ground it is nothing at all: §3.1 forbids an absolute foreground in a
palette with no established background, and the last rung's wash is reverse
video, where a grey inverts into a grey block.

**2.2 The floor is a floor, including mid-animation.** A mark that
breathes bottoms out at the dim token and never below it. This has
shipped wrong once — index `252` is 1.54:1 on white, invisible.

**2.3 A fixed red is not theme-safe.** ANSI `31` (`#CC0000`) is 5.89:1 on
white but **2.83:1** on a dark ground, so the failure colour is
theme-resolved like everything else in the table.

**2.4 Emphasis is never a background.** To make one token the brightest
thing in a dim run, cancel the dim and add weight — do not paint behind
it. A background reads as a block on an otherwise plain row, and the
property wanted was contrast, not a surface. (§1.6's two surfaces are
the exception, and they mean something else.)

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
unknown kiso does not guess a wash; it uses the mark that is correct on
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
or a full-width wash that is the wrong colour on every row of a command
block, and a settled default is indistinguishable from a resolved one to
everything downstream. The persisted `theme` is the answer for a
terminal that reports nothing.

---

## 4. The marks

| mark | means |
|---|---|
| `●` | work is in flight — see §7.3 for which row wears it |
| twinkle (§5.2) | the model is thinking (the status row) |
| `❯` | it needs you: an approval or a question is pending |
| `◦` | queued, not started |
| `✦` | the turn's seal (`✦ took …`) and the checklist header |
| `▾ ▸ │` | the transcript viewer's marks (§9) |
| (none) | a settled call, and a folded stretch — the outcome is in the words |

**4.1 One mark, one meaning, everywhere.** A mark that means two things
is worse than two marks.

**4.2 The fold wears no mark.** When the fold, the live line and the
status row all wore a star, none of them distinguished anything — the
tick and the cross again (§1.3) at the stretch scale. A folded stretch
is indented two spaces to join the settled-call family's geometry, and
its words carry the record.

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
command   ● in 232 → 236 → 240 → 243 → 240 → 236 → 232   (light)
          ● in 255 → 251 → 248 → 246 → 248 → 251 → 255   (dark)
thinking  ✧ → ✦ → ✶ → ✸ → ✺ → ✸ → ✦, settling on ✦
```

The command breath is **brightness only** — one glyph, seven greys,
bottoming out at the dim token per §2.2. The thinking twinkle is
**glyphs only**, so it survives `NO_COLOR` while the breath correctly
freezes to a static `●`.

**5.3 A breath says alive; a turn says counting.** A call whose duration
cannot be predicted gets no mark implying progress it does not have, so
neither animation rotates — and a mark lit while nothing moves is the
same error. One that is gone before the eye lands is not a mark at all,
which is why the breath rides the activity and not each call (§7.3).

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
about the terminal's.

---

## 7. The turn on screen

A turn is thinking, work, and an answer. §7 says how those three occupy
rows, and it is the part of this file the rest of the product is most
easily broken against: **the screen must not move under the reader.**

**7.1 Committed rows are final.** A row that has entered the terminal's
scrollback is never re-emitted, reflowed or erased (ADR-0046). So kiso
cannot expand anything in place after the fact — an expansion appends.
Everything below is downstream of that.

**7.2 Thinking is words.** The model's thinking renders as its own
paragraph — dim, italic, indented two spaces, blank line between
paragraphs — and never folds. It closes the current stretch rather than
joining one: what the model says is not work.

The indent is the price of §1.2: italic is an escape sequence, so a
piped transcript would lose the line between the model's reasoning and
its answer. Two spaces survive as bytes.

**7.3 A running call is the same card, at a fixed height.** It is
allocated at the settled card's height on its first frame and only ever
shrinks — at the settle, when its result turns out to be shorter than
the window it was given. So a settle changes a row's CONTENT and never
its position: the breathing mark becomes two spaces in the same two
columns, and the metadata row that said `3s` says `exit 0 · 90 lines ·
3.2s`.

The live region as a whole is capped at the room the committed rows
leave. That is what keeps the window's top from falling: it is read off
the total height, so a live region that can push the total over `H`
makes a settle pull it back under, and every row on screen slides down
by the difference. Capped, the top depends only on how much has
committed, which only grows. Where the room is tight the cards give way
first — the window shrinks toward one preview row, and below the
seven-row skeleton a call keeps its head row until it commits (DC-43).
Committed cards are never trimmed (§7.1).

*Amended R13 (2026-09-03), owner-ruled.* This section described the
standing activity block (R4): one allocation for a whole stretch, its
contents swapping, its height constant. It bought "nothing moves" by
never shrinking. With the fold retired there is no one-line form for it
to release into, and the same property comes from the other side — the
card's fixed height, and the live region's cap. The residual cost is
recorded as DC-46.

**7.4 A settled call is a CARD.** One object, one shape, every call:

```
  <pad>
  shell npm test
  <blank>
  … 85 earlier lines · ctrl+o expands
  <the last five output rows>
  <blank>
  exit 0 · 90 lines · 0.4s
  <pad>
```

Pad, head, blank, preview, blank, outcome, pad — twelve rows at most,
every row at COLUMN 2 (§1.8), the whole of it washed full width where
the ground is known. `└` does not open it: the surface is the container,
and a corner inside one is §1.3's empty mark a scale up.

**A call with nothing to preview is the same card in three rows**, its
outcome riding the head row because there is nothing between them to
close.

**The preview caps at five rows.** A shell shows its TAIL with the cut
note above it — the conclusion of a command is at the bottom of its
output — and everything else shows its HEAD with the note below, because
that is where their answer is. **A read shows nothing at all**: its
result is the file, five lines of it tell a reader less than the head
row already does, and the key opens the whole thing. Its continuation
note, when the tool itself capped the result, is not a preview and stays.

**Where the ground is NOT known the card does not paint at all.** Rung
4's wash is reverse video (§3), and one inverted chip row is the ladder
working while eight inverted output rows are a black slab in the middle
of the transcript. Unpainted, the block is the four-column indent, one
level deeper than prose and than the head row, with `└` opening it and
the metadata rows dim. The CONTENT is the same either way — only the
surface, its pads and its two blank rows are contingent, because an
unpainted blank row is §1.3 at the scale of a row.

That four-column indent carries a §1.2 fact — these rows are the call's
output, not something the model said — which is why it is an indent and
not a glyph: it survives a pipe. Inside a painted card the head row and
the outcome row bracket the preview instead, so the indent is no longer
what says "these rows are output" and every row sits at column 2. The
diff's `│` is untouched: there it SCOPES rather than separates, which is
the case §1.1 keeps it for.

**7.5 A card reads verb · target, then outcome.** The head row says what
was run; the outcome row says what happened, how much of it there was
and how long it took. On the three-row card the two share a row.

The verb column is padded to 5 so targets line up, and the target is
bold on the head row. A failure takes no tint on the card; only the
outcome word is coloured, which is §1.2 exactly — the colour rides the
fact, not the object carrying it.

Both metadata rows give way in a pinned order when the width squeezes:
the attribution first, then the count, and the key is RESERVED — a row
that says how much is hidden without saying how to see it is the silence
the affordance exists to remove. Neither row ever folds; it is cut.

Only a call still running carries a mark, because only it is moving.

**7.6 Deleted (R13, 2026-09-03).** It read: *a folded stretch is one
line, and prints no key*. Nothing folds (§1.7), so there is no line for
it to govern. Kept as a numbered stub because §7's numbers are
referenced from the code and from the findings record.

**7.7 `ctrl+o` has exactly one target and says which.** The row it will
act on renders its own `ctrl+o` token at full strength among dim
siblings — exactly one bright token per frame. Two would be a lie about
a single-target key; zero puts the reader back to pressing and finding
out. Per §2.4 the emphasis is weight, not a background.

**7.8 The composer is four rows and stays four rows.** `CHROME_ROWS` is
4: rule, input, rule, status. Every gate keyed on `H − 4` depends on it.

**7.9 The user's words span the width.** Full width, REVERSE VIDEO, per
§1.6 — the human's surface, one form on every ground, never the wash.
Its inner pad is TWO columns, so the human's words begin in the same
column as the model's and as a card's rows (§1.8). The block is padded
to `W` by *display* width, so a CJK row pads
correctly, and it folds by WORD: the character fold was defended as
lossless, which is not a property CJK has, and every other prose
surface already folds by word. A word wider than the row still breaks
mid-word, because an overflowing row breaks invariant ①.

**7.10 The opening.** No logo. The name is the mark.

```
kiso <version>

  MODEL       <model> · <mode>
  WORKSPACE   <cwd>
  EXTENSIONS  <n> loaded · /ext lists them

  esc interrupt · ctrl+c exit · / commands · @ files · ? keys
```

Three labelled facts answer the three questions a first screen is asked
— what model, where am I, what is loaded. A rendered wordmark costs
seven rows to say what `kiso` says in one.

The opening scrolls the shell's screen away first: H line feeds from
the shell's cursor carry its prompt, the launch command and the tail of
what ran before into the scrollback as content, and the first frame
then owns rows 1..H. What was on screen is one scroll up, not gone
(DC-40). The feeds precede the entry reset, because `ESC[r` homes the
cursor and feeds after it scroll one row instead of the shell's r.

---

## 8. The bands, and the hint

A band is a surface that opens directly above the composer: the
command list, the `@` picker, the session picker. The keys sheet is
the same vocabulary on the body.

**8.1 A band names itself.** `─── commands ───`, `─── files ───`,
`─── sessions ───`, `─── keys ───`. With scrollback behind it, nothing
else says where the surface begins.

**8.2 A band is a WINDOW, not the whole list.** Five rows and a
counter — and the counter appears only when the list is actually cut,
because over rows you can all see it says nothing they do not. Rows
are a table: the name column padded to the longest entry in the WHOLE
list so the descriptions do not shift as the window scrolls, and a
long description CUT rather than folded, since a fold would break the
height the window buys.

**8.3 A band opens on its sigil.** `/` alone opens the command list;
the list that names the commands must not require you to name one
first. The rows do not repeat the sigil — it is on the input line
directly below them.

**8.4 Enter completes; the NEXT enter sends.** The same rule for every
band. Completing and sending on one key would send a fragment.

**8.5 The idle hint gives way in order, and it is where a key that
nothing else advertises has to live.** The hint is dropped WHOLE when
it does not fit, so the forms are a ladder and every rung is one that
fitted at some width — a rung skipped is an affordance lost at a width
that could have shown it. Order by how findable the key is WITHOUT the
hint: `/ commands` survives longest, and a key like `ctrl+r` that
nothing stumbles onto outranks one like `↑ history` that everyone does.

---

## 9. The transcript viewer

`ctrl+r` opens a reader over the turn's record. It exists because §7.1
makes expand-in-place impossible: looking back needs a surface that can
be redrawn, and committed rows are not one.

**9.0 Which key, and why this one.** The viewer held `ctrl+o` from
0.19.0 to 0.20.4, on the bet that a borrowed key transfers muscle
memory. It transfers the key and betrays the action: elsewhere `ctrl+o`
expands the tool output in front of you, which is §7.7's job, not this
one — reported from real use (DC-41). So `ctrl+o` is the expand key and
the viewer takes `ctrl+r`. No control key was free of a collision
somewhere; `ctrl+r` is the cheapest, because what it displaces
elsewhere is renaming a session and kiso has nothing to rename. The
viewer fires only on an idle, empty composer, so the collision can only
ever land where the other product's binding is itself a no-op.

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
- **The live region's floor (DC-46).** The live region is capped at what
  the committed rows leave (§7.3), which is what keeps the window's top
  from falling. On a SHORT terminal with a lot of committed work that
  leaves one row, so DC-43's shrink takes the running call down to its
  head row — and the running call's output is the one thing on screen
  the human is waiting for. The alternative (give the live region the
  room it needs and clamp the window's top instead) has its own measured
  cost, the blank hole above the composer that R7a priced at 65 → 692 of
  733 frames. Both measurements are in DC-46; the choice is the owner's.
  Until then a residual one-row shift at a partially-settled burst is
  bounded and gated (R7a A).
- **A per-call title.** Naming what a call is *for*, in the model's own
  words, would mean the model authoring it — a request-byte change and a
  different release tier, not a visual round. §7.2's visible thinking
  already carries the narration at no schema cost, which is the reason
  this stays open rather than planned.

---

## 11. Amending this file

State the rule as it now stands, in the present tense, and delete what
it replaced. This file is the contract, not its history — the arguments
live in `bench/rd1/findings/` and the commits.

A change must say what became true, so a reader can tell a decision from
a drift, and must leave the file consistent: a rule the code contradicts
is a bug in one of them, and this file does not get to be the stale one.
