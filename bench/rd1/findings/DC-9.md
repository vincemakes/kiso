# DC-9 — the failure colour is fixed, and the gate that should have caught it computes the wrong number

- **id:** DC-9
- **class:** contrast / palette
- **severity:** P1 — every failed tool call on every dark terminal
- **agent:** kiso 0.16.3
- **found by:** reading `palette()` out of the shipping build across all
  three grounds while auditing the nineteen screens against
  `packages/tui/design.md`
- **status:** FIXED (0.16.4 working tree)

## The measurement

```
ground=light   red "\x1b[31m"
ground=dark    red "\x1b[31m"
ground=unknown red "\x1b[31m"
```

Design §2.3 is explicit: *"A fixed red is not theme-safe. ANSI 31
(`#CC0000`) is 5.89:1 on white but **2.83:1** on a dark ground."* The
token whose entire job is *this went wrong* was the least readable thing
on the screen exactly where a dark-terminal user reads it, and DC-3 had
already moved `wash` onto the ground ladder without moving `red`.

## The cause

`withWash` builds all three ON palettes by spreading `BASE`, and `red`
lives in `BASE`. Only `wash` was parameterised, because DC-3's argument
— *"`dim` is an attribute and therefore adapts; only the BACKGROUND
genuinely needs to know the ground"* — is correct about `dim` and does
not extend to a foreground that is content rather than chrome. Law 1.2
admits colour inside content; a content colour cannot degrade to an
attribute, so it needs a value per ground.

## The second half: the gate measured black

`packages/tui-cells/tests/dc3-palette-ground.test.ts` already sweeps
every `38;5;N` in a palette against its own ground and demands 4.5:1. It
did not catch this because nothing was there to catch — and when the fix
put index 173 in `COLOR_DARK`, the gate reported **1.26:1** and failed a
colour that measures 5.97:1.

Its `grey(n)` helper covers only the 232–255 grey ramp and returns
`#000000` for everything else. That was safe while the greys were the
only absolute foregrounds the product spent, and silently wrong the
moment a 6×6×6 cube index arrived. A gate that computes the wrong
number is worse than no gate, because it is believed.

## The fix

- `withWash` takes the failure colour per ground: light `38;5;124`
  (`#af0000`, **7.44:1** on white), dark `38;5;173` (`#d7875f`,
  **5.97:1** on `#1e1e1e`). 256-cube indices, never truecolor (§2).
- The UNKNOWN ground keeps ANSI 31 — the terminal's own red, which its
  own theme picked for its own background. That is rung 4's principle
  applied to a foreground: when the ground is unknown, use the thing
  that is correct on any ground rather than guessing one.
- `grey(n)` becomes `rgbOf(n)`, covering the cube (16–231) as well as
  the ramp, and THROWING on 0–15 — those are terminal palette slots with
  no fixed sRGB, which is precisely why the product never spends them as
  absolute colours.

## Red before green

The existing floor sweep, now correct, plus four cases in the same file:
the token is an absolute index per ground and the two grounds differ;
the unknown ground keeps `\x1b[31m`; `NO_COLOR` keeps `""`; and
`palette()` routes it like every other token.
