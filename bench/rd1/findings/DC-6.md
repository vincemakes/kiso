# DC-6 — a multi-line user chip pads every paragraph to its own width

- **id:** DC-6
- **class:** rendering / layout
- **severity:** P2 — every message longer than one line, on every turn
- **agent:** kiso 0.16.2
- **found by:** dumping the shipping renderer while writing
  `packages/tui/design.md`; re-measured against 0.16.2 before the fix
- **status:** FIXED (0.16.2 working tree)

## The measurement

`Body.userLine("hello\nthis is a much longer second line here\nok")` at
width 56, frame bytes with the SGR stripped:

```
 7 cols   " hello "
40 cols   " this is a much longer second line here "
 4 cols   " ok "
```

Three rows of one message, three widths. The chip is reverse video, so
what the reader sees is three bars of three different lengths with a
ragged right edge.

## The cause

`UserMessage.render` folds one source paragraph at a time and computes
the pad width **inside** that loop:

```ts
for (const para of paras) {
    const folded = foldLine(escapeTerminal(para), chipW);
    const inner = Math.max(...folded.map((r) => displayWidth(r)));
    for (const row of folded) {
        const pad = inner - displayWidth(row);
        rows.push(`${p.rv} ${row}${" ".repeat(pad)} ${p.rvEnd}`);
    }
}
```

`inner` is the longest row **of that paragraph**, not of the block. A
single-paragraph message is therefore correct, which is why this
survived: the shape only appears once a message has two lines, and the
tests that cover the chip use one.

## The fix

Fold every paragraph first, keep the rows, take one `inner` over all of
them, then pad. The padding authority stays `displayWidth`, so a CJK row
still pads by display width and never by character count.

The `USER_CHIP_ROWS` cap and its `+N more lines · sent in full` row are
untouched: the cap is applied while folding, and the notice sits outside
the reverse-video span, where it already is.

## Red before green

`packages/tui-cells/tests/dc6-user-chip-width.test.ts` — five cases:
three paragraphs at one width, the width is the longest row plus the two
side pads, a one-paragraph chip is unchanged, a CJK row pads by cells,
and a folded chip keeps one width. Red 3/5 at 7 / 40 / 4; the two that
passed were the single-paragraph cases, exactly as the cause predicted.
