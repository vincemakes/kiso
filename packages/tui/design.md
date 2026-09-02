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
ladder, nothing to under-read. **The wash is the MACHINE'S verbatim
surface** — *this text is reproduced exactly as it was given*: inline
code, and a call's own output. A lighter ground is right there, because
those rows are read as content rather than heard as an utterance.

Neither is an emphasis. Nothing is washed, and nothing is inverted, to
make it stand out.

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
palette with no established background, and rung 4's wash is reverse
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

**7.4 A tool block is a SLAB, and its rows are INDENTED.** A single
call's block is one object: the head row names the call, its own output
sits inside, and the outcome closes it. Where the ground is known, the
whole block is washed full width — §1.6's machine-verbatim surface,
saying where the call begins and ends — and `└` does not open it,
because the surface is the container and a corner inside one is §1.3's
empty mark a scale up.

**Where the ground is NOT known the slab does not paint at all.** Rung 4's
wash is reverse video (§3), and one inverted chip row is the ladder
working while eight inverted output rows are a black slab in the middle
of the transcript. Unpainted, the block is what it has always been: the
four-column indent, one level deeper than prose and than the header row,
with `└` opening it and the metadata rows dim. The CONTENT is the same
either way — only the surface and its two blank rows are contingent,
because an unpainted blank row is §1.3 at the scale of a row.

The indent carries a §1.2 fact — these rows are the call's output, not
something the model said — which is why it is an indent and not a glyph:
it survives a pipe. The notes inside the block (`… N earlier lines`,
`waiting for output`, the collapse footer) take the same indent and no
glyph. The diff's `│` is untouched: there it SCOPES rather than
separates, which is the case §1.1 keeps it for.

**7.5 A settled call reads verb · target · outcome.** Where the call
has no output on screen it is ONE row and the outcome rides it; where it
does, the outcome closes the slab on its own row and the head row is
free to be the command:

```
  read  loop.ts             412 lines · 0.1s · ctrl+o expands

  shell pwd && ls -la
    … 83 earlier lines · ctrl+o expands
    <the last five output rows>
    exit 0 · 88 lines · 0.4s
```

The verb column is padded to 5 so targets line up, and the target is
bold on a slab's head row — the row's job there is to say WHAT was run.
A failure takes no tint on the block; only the outcome word is coloured,
which is §1.2 exactly — the colour rides the fact, not the object
carrying it.

Both metadata rows give way in a pinned order when the width squeezes:
the attribution first, then the count, and the key is RESERVED — a row
that says how much is hidden without saying how to see it is the silence
the affordance exists to remove. Neither row ever folds; it is cut.

Only a call still running carries a mark, because only it is moving.

**7.6 A folded stretch is one line, and prints no key.** It says what the
work was, in the tense each term earned — `read 4 files · ran 1 shell
command` — and drops any term whose count is zero. It prints no
selector: a number you cannot type is decoration that costs a column.

**7.7 `ctrl+o` has exactly one target and says which.** The row it will
act on renders its own `ctrl+o` token at full strength among dim
siblings — exactly one bright token per frame. Two would be a lie about
a single-target key; zero puts the reader back to pressing and finding
out. Per §2.4 the emphasis is weight, not a background.

**7.8 The composer is four rows and stays four rows.** `CHROME_ROWS` is
4: rule, input, rule, status. Every gate keyed on `H − 4` depends on it.

**7.9 The user's words span the width.** Full width, REVERSE VIDEO, per
§1.6 — the human's surface, one form on every ground, never the wash.
The block is padded to `W` by *display* width, so a CJK row pads
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
