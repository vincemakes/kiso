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

*Known cost, accepted:* a failure has no shape, only a colour and its
words. `⏸` survives this law because it does not describe an outcome —
it means *you have to do something*.

**1.4 Two marks, one beat.** A running command breathes; a running
thought twinkles. Nothing else in the product moves. See §5.

**1.5 Labels are mono, uppercase, dim.** `MODEL`, `WORKSPACE`. They mark
sections. They are never content.

**1.6 The wash means verbatim.** A washed surface says *this text is
reproduced exactly as it was given*: the human's own words, and inline
code. One token, one idea. The wash is a surface, never an emphasis —
nothing is washed to make it stand out.

**1.7 Work folds, words do not.** Tool calls collapse to one dim line
when their stretch closes. Everything the model *says* — its answer and
its thinking alike — stays as words. The fold line names what it stands
for in words.

---

## 2. The palette

kiso emits 256-colour indices, never truecolor.

| token | light | dark | contrast |
|---|---|---|---|
| body | terminal default | terminal default | — |
| dim | `243` `#767676` | `246` `#949494` | 4.54 / 5.50 |
| wash (bg) | `255` `#EEEEEE` | `236` `#303030` | 14.55 / 10.20 |
| failure | `#A8442B` | `#E08A6B` | 5.95 / 6.36 |
| added / removed | `32` / `31` | `32` / `31` | — |

Contrast is the WCAG relative-luminance ratio of the token against its
ground (dark measured against `#1E1E1E`). The floor for anything a human
reads is **4.5:1**.

**2.1 Nothing dim ever sits on the wash.** `#767676` on `#EEEEEE` is
3.91:1 and `#949494` on `#303030` is 4.35:1 — both under the floor. The
wash carries body text only.

**2.2 The floor is a floor, including mid-animation.** A mark that
breathes bottoms out at the dim token and never below it. This has
shipped wrong once — index `252` is 1.54:1 on white, invisible.

**2.3 A fixed red is not theme-safe.** ANSI `31` (`#CC0000`) is 5.89:1 on
white but **2.83:1** on a dark ground, so the failure colour is
theme-resolved like everything else in the table.

**2.4 Emphasis is never a background.** To make one token the brightest
thing in a dim run, cancel the dim and add weight — do not paint behind
it. A background reads as a block on an otherwise plain row, and the
property wanted was contrast, not a surface. (§1.6 is the one thing that
gets a surface, and it means something else.)

---

## 3. The ground

Every rule in §2 needs one fact: **is the terminal light or dark**.
Resolution ladder, first hit wins:

1. `KISO_THEME=light|dark` — an explicit answer always wins.
2. **OSC 11** — ask the terminal for its background colour, compute
   luminance. Queried once at startup with a bounded wait; never per
   frame.
3. `COLORFGBG` — set by some terminals, absent on many.
4. **Reverse video** — theme-free by construction. Heavier, never wrong.

**3.1 Rung 4 is the safety property, not a leftover.** When the ground is
unknown kiso does not guess a wash; it uses the mark that is correct on
any ground. The design degrades; it never renders light-mode paint on a
dark screen.

**3.2 The ladder runs whether or not the terminal answers.** Rungs 1 and
3 are resolved before the OSC query and again with its reply. A terminal
that never answers still gets `KISO_THEME` and `COLORFGBG`; only rung 2
is contingent. Apple Terminal answers rung 2; the wider survey is not
done, which bounds how confidently §2 can be said to ship as designed.

---

## 4. The marks

| mark | means |
|---|---|
| `●` | work is in flight — see §7.3 for which row wears it |
| twinkle (§5.2) | the model is thinking (the status row) |
| `⏸` | it needs you: an approval or a question is pending |
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

**4.3 `⏸ ask pending · answers are durable facts`.** The pending panel
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
- **Absent:** braille (`U+2800`–`U+28FF`) and the finer legacy block
  sets (sextants, octants). They render as empty boxes; no macOS system
  font supplies them.

**6.1 Emoji-capable glyphs are forbidden in chrome.** A glyph present in
Apple Color Emoji may be drawn coloured and **double-width**, tearing a
row whose width was computed as one cell. `✳` (`U+2733`) and `✴`
(`U+2734`) are the two a star ramp reaches for first, and both are in
that font — which is why the twinkle uses `✧ ✦ ✶ ✸ ✺`. Check the emoji
font's table before adopting any new symbol.

**6.2 Ink area is the size axis, not the code point.** A ramp is ordered
by measured ink. At 60px in Menlo: `·` 72, `✧` 144, `•` 235, `✦` 248,
`✶` 311, `○` 364, `✸` 536, `✺` 566, `●` 1014.

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

**7.3 The activity block stands for the turn.** It is allocated at the
turn's first thought and released when the stretch folds. Within it:

- **Every call keeps its row** for the life of the stretch: it takes one
  when it starts and changes *in place* when it finishes, so a four-file
  burst leaves four names behind. Rows only accumulate, which is what
  holds the height steady — **no padding**, because reserving rows with
  nothing in them is §1.3 at the block scale and leaves a hole above the
  composer.
- **What is happening now outranks what happened.** In-flight rows are
  admitted first and are never truncated; the call's own output follows
  when it is the only one running; finished names fill what is left,
  newest first; the rest is counted (`+N more running`), and that count
  is of calls actually running.
- **One breathing mark** — on the activity line when the stretch has
  more than one call, on the call's own row when it has one, lit only
  while something is in flight (§5.3).
- **The block takes the spacing its FOLD will take**, never its own, so
  a settle changes a row's content and not its position.

**7.4 A tool block's rows are INDENTED, not guttered.** Four columns,
one level deeper than prose and than the header row. The fact this
carries — these rows are the call's output, not something the model
said — is a §1.2 fact and so it lives in the indent, which survives a
pipe, rather than in a glyph. `└` opens a block, exactly once, on its
first row that has content; the notes inside it (`+N earlier rows`,
`waiting for output`, the collapse footer) take the same indent and no
glyph, because a second `└` in one block is one mark meaning two
things. The diff's `│` is untouched: there it SCOPES rather than
separates, which is the case §1.1 keeps it for.

**7.5 A settled call reads verb · target · outcome.**

```
  edit  compositor.ts       +7 −3 · 0.4s · ctrl+r
  shell npm run check       exit 0 · 82 lines · 12.4s · ctrl+r
  shell npm test            exit 1 · 4 failures · 2.1s · ctrl+r
```

The verb column is padded to 5 so targets line up. Only a call still
running carries a mark, because only it is moving.

**7.6 A folded stretch is one line, and prints no key.** It says what the
work was, in the tense each term earned — `read 4 files · ran 1 shell
command` — and drops any term whose count is zero. It prints no
selector: a number you cannot type is decoration that costs a column.

**7.7 `ctrl+r` has exactly one target and says which.** The row it will
act on renders its own `ctrl+r` token at full strength among dim
siblings — exactly one bright token per frame. Two would be a lie about
a single-target key; zero puts the reader back to pressing and finding
out. Per §2.4 the emphasis is weight, not a background.

**7.8 The composer is four rows and stays four rows.** `CHROME_ROWS` is
4: rule, input, rule, status. Every gate keyed on `H − 4` depends on it.

**7.9 The user's words span the width.** Full width, washed, per §1.6.
The block is padded to `W` by *display* width, so a CJK row pads
correctly.

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
hint: `/ commands` survives longest, and a key like `ctrl+o` that
nothing stumbles onto outranks one like `↑ history` that everyone does.

---

## 9. The transcript viewer

`ctrl+o` opens a reader over the turn's record. It exists because §7.1
makes expand-in-place impossible: looking back needs a surface that can
be redrawn, and committed rows are not one.

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

- **`⏸` against §6.1.** It is absent from Menlo *and* present in Apple
  Color Emoji — both failure modes §6 names, in one glyph, and worse
  than the `✳`/`✴` that §6.1 bans. Unresolved; the mark is still in use.
- **The wider OSC 11 survey** (§3.2). Bounds how much of §2 can be said
  to ship as designed.
- **Spilled stretches.** A stretch too tall for its slot spills; how a
  spilled stretch folds is not settled.
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
