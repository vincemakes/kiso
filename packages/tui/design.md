# kiso tui — the design contract

Scope: `packages/tui` and `packages/tui-cells`. Everything drawn on a
terminal by kiso is governed here.

This is not a plan and not a proposal record. It is the standing
description of what the screen is, written down so that a later round
cannot quietly reverse it and so that a reviewer can check a diff
against something. **Changing a rule in this file is a decision; a
change to the code that contradicts a rule here is a bug.**

Each rule carries a status:

- **SETTLED** — ruled on by the owner. Reversing it needs a new ruling,
  recorded in this file with the reason, next to the old one.
- **PROPOSED** — designed, not yet ruled on. Implement only after the
  ruling.
- **OPEN** — the answer is not known yet, and the reason it is not known
  is written down.

---

## 1. The laws

**1.1 One hairline. SETTLED.** A single dashed rule (`╌`) is the only
divider on screen. Not boxes, not gutters, not a second weight. A rule
is a *delimiter*; a box is a *container*, and kiso has at most one
container-shaped thing on screen at a time.

*Reversal on the record:* the composer was two dotted rows until W6
turned it into a rounded box, reasoning that "the box already says
'input lives here'". That is now reversed. The reversal is not a taste
correction — it is the decision to have **one** edge vocabulary instead
of three (box, gutter-with-tail, bare rows).

**1.2 Grey chrome, coloured content. SETTLED.** Frames, labels, keys and
metadata are dim ink and never coloured. Colour appears only inside
content: diff signs, and a failure. Strip every escape sequence and no
fact is lost.

**1.3 No empty marks. SETTLED.** A symbol earns its cell by carrying a
fact the words do not. A row that already says `exit 0` does not also
need a tick saying it went fine, so the tick is gone; so is the cross.
An outcome is stated in **words** (`exit 0`, `exit 1 · 4 failures`),
which is also the only form that survives a pipe.

*Known cost, accepted:* a failure no longer has a shape, only a colour
and its words. On a full screen it is less likely to catch the eye than
a red `✗` did. `⏸` survives this law because it does not describe an
outcome — it means *you have to do something*.

**1.4 Two marks, one beat. SETTLED.** A running command breathes; a
running thought twinkles. Nothing else in the product moves. See §5.

**1.5 Labels are mono, uppercase, dim.** `MODEL`, `WORKSPACE`. They mark
sections. They are never content.

**1.6 The wash means verbatim. SETTLED.** A washed surface says *this
text is reproduced exactly as it was given*: the human's own words, and
inline code. One token, one idea.

*Reversal on the record:* the user chip was sized to its longest row,
because "a short message like `/think` would paint a bar across the
terminal". That reasoning optimises the one-word case at the cost of
every real message, and the band is now full width. The `/think` case is
accepted as the price.

**1.7 Work folds, words do not.** Tools and thinking collapse to one dim
line; what the model says stays. The fold line names its own key.

---

## 2. The palette

kiso emits 256-colour indices, never truecolor. The `code` token is
retired as a foreground colour: inline code is a **surface** now
(law 1.6), which is what removes it from the contrast problem instead of
moving it around.

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
breathes must bottom out at the dim token and never below it. The
defect this prevents is the one that shipped: inline code at index
`252` = `#d0d0d0` is **1.54:1** on white, invisible on the ground the
product is actually used on.

**2.3 A fixed red is not theme-safe.** ANSI `31` (`#CC0000`) is 5.89:1
on white but **2.83:1** on a dark ground. The failure colour is
therefore theme-resolved like everything else in the table.

---

## 3. The ground

Every rule in §2 needs one fact: **is the terminal light or dark**.
kiso does not currently know, and picks absolute colours. Resolution
ladder, first hit wins:

1. `KISO_THEME=light|dark` — an explicit answer always wins.
2. **OSC 11** — ask the terminal for its background colour, compute
   luminance. Queried once at startup with a bounded wait; never per
   frame.
3. `COLORFGBG` — set by some terminals, absent on many.
4. **Fall back to reverse video** — the pre-existing chip, theme-free by
   construction. Heavier, never wrong.

**3.1 Rung 4 is the safety property, not a leftover.** When the ground
is unknown kiso does **not** guess a wash. It uses the mark that is
correct on any ground. The design degrades; it never renders light-mode
paint on a dark screen.

**3.2 Status: OPEN.** Whether rung 2 fires on the terminals kiso is
actually used on has not been measured. Until it has, how much of §2
ships as designed is unknown. `kiso-doc/probe-bg.mjs` prints the raw
reply so that "no answer" and "malformed answer" stay distinguishable.

---

## 4. The marks

| mark | means | status |
|---|---|---|
| `●` | a command is running | SETTLED |
| twinkle (§5.2) | the model is thinking | SETTLED |
| `✦` | a folded segment — thinking and tools, collapsed | PROPOSED |
| `⏸` | it needs you: an approval or a question is pending | SETTLED |
| `◦` | queued, not started | unchanged |
| (none) | a settled call — the outcome is in the words | SETTLED |

**4.1 The mark that runs is the mark that stays.** The twinkle settles
onto `✦`, so the glyph a human watches while the model thinks is the
glyph left behind when the thought collapses into a record. Nothing new
is introduced at the transition.

**4.2 One mark, one meaning, everywhere.** If `✦` heads a folded
segment, then the expanded header is `✦ expanded · … · back` — not the
older `▞`. A mark that means two things is worse than two marks.

**4.3 `⏸ ask pending · answers are durable facts`.** The pending panel
states its own durability. This costs one status string and is the only
line in the interface that says something no other agent's option panel
can say: kill the process, come back, the question is still here and the
answered ones are not asked again.

---

## 5. Motion

**5.1 The cadence is the existing spinner tick.** `SPINNER_MS` is 200ms.
Seven steps of it is **1.4 seconds**. Both animations are seven frames,
so the frame cadence does not change and neither does the byte volume of
a waiting screen.

**5.2 The two cycles.**

```
command   ● in 232 → 236 → 240 → 243 → 240 → 236 → 232   (light)
            ● in 255 → 251 → 248 → 246 → 248 → 251 → 255   (dark)
thinking  ✧ → ✦ → ✶ → ✸ → ✺ → ✸ → ✦, settling on ✦
```

The command breath is **brightness only** — one glyph, seven greys,
bottoming out at the dim token per §2.2. The thinking twinkle is
**glyphs only** — no colour at all, so it is intact under `NO_COLOR`
while the breath correctly freezes to a static `●`.

**5.3 A breath says alive; a turn says counting.** A call whose duration
cannot be predicted must not be given a mark that implies progress it
does not have. This is why neither animation rotates.

---

## 6. Glyph budget

The renderer may only use glyphs the terminal's font actually has.
Measured against Menlo, macOS's terminal default:

- **Available:** quadrant and shade blocks, eighth bars, box drawing,
  circles and arcs (`· • ● ○ ◎ ◉ ◦ ∘`), triangles, diamonds, the star
  family, arrows.
- **Absent:** braille (`U+2800`–`U+28FF`) and the finer legacy block
  sets (sextants, octants). They render as empty boxes. No macOS system
  font supplies them.

**6.1 Emoji-capable glyphs are forbidden in chrome.** A glyph present in
Apple Color Emoji may be drawn coloured and **double-width**, which
tears a row whose width was computed as one cell. `✳` (`U+2733`) and
`✴` (`U+2734`) are the two that a star ramp reaches for first, and both
are in that font — which is why the twinkle in §5.2 uses `✧ ✦ ✶ ✸ ✺`
instead. Check the emoji font's character table before adopting any new
symbol.

**6.2 Ink area is the size axis, not the code point.** A ramp must be
ordered by measured ink, not by name. For reference, at 60px in Menlo:
`·` 72, `✧` 144, `•` 235, `✦` 248, `✶` 311, `✷` 338, `○` 364, `◎` 473,
`✸` 536, `✺` 566, `◉` 787, `●` 1014.

---

## 7. Layout

**7.1 The opening. SETTLED.** No logo. The name is the mark.

```
kiso 0.15.12

  MODEL       <model> · <mode>
  WORKSPACE   <cwd>
  EXTENSIONS  <n> loaded · /ext lists them

  esc interrupt · ctrl+c exit · / commands · ! bash · ctrl+r expand
```

Three labelled facts answer the three questions a first screen is asked
— what model, where am I, what is loaded. The ASCII wordmark is
retired. A rendered clover mark was tried at 4×2, 10×5, 14×7 and 16×8
and rejected: below 14 columns the centre star closes and the mark reads
as a domino, and at 14 columns it costs seven rows to say what the word
`kiso` says in one.

**7.2 The composer is four rows and stays four rows. SETTLED.**
`CHROME_ROWS` is 4: rule, input, rule, status. Every gate keyed on
`H − 4` depends on this. The box→rules change (law 1.1) is deliberately
row-neutral; it returns two columns to the input by dropping the box's
sides.

**7.3 The user's words span the width.** Full width, washed, per law
1.6. The block is padded to `W`, and the padding authority stays
`charWidth` so a CJK row pads by display width and never by characters.

**7.4 A settled call reads verb · target · outcome.**

```
  edit  compositor.ts       +7 −3 · 0.4s · ctrl+r
  shell npm run check       exit 0 · 82 lines · 12.4s · ctrl+r
  shell npm test            exit 1 · 4 failures · 2.1s · ctrl+r
```

The verb column is padded to 5 so targets line up. Only the call still
running carries a mark in the gutter, because only it is moving.

**7.5 The pending panel uses the same rule as the composer.** Dashed
above and below; the selected option carries `→` **and** reverse video —
bold alone is close to invisible on a light ground; option descriptions
sit in a right column rather than after an em dash.

---

## 8. Open

- **§3.2 — does the terminal answer OSC 11.** Unmeasured. Blocks how
  much of §2 ships as designed.
- **`✦` as the folded-segment mark.** PROPOSED; §4 depends on the
  ruling.
- **Law 1.1 applied to the ask panel.** The composer half is settled;
  the panel half is PROPOSED, and it is the widest test surface in the
  set — four suites assert its rows verbatim.
- **When a segment folds.** `turnFold` already writes the folded line,
  but only for a turn that ends with no text at all. Folding at every
  text boundary changes *what commits and when*, which is the machinery
  every scrollback gate watches. It is not part of this contract yet and
  must not ride in a visual round.

---

## 9. Amending this file

State the new rule, keep the old one next to it with its original
reasoning, and say what changed the answer. A rule deleted without its
reversal recorded is how the same argument gets had three times.
