# DC-1 — `/help` prints a ragged column, and one of its rows is two rows

- **id:** DC-1
- **class:** rendering / string construction
- **severity:** P3 — cosmetic, but it is the same defect class as
  REL-0152 chip raggedness, in a surface every new user reads first
- **agent:** kiso 0.15.12 (working tree)
- **found by:** dumping every UI surface while writing
  `packages/tui/design.md`
- **status:** FIXED (0.16.2 working tree)

## The measurement

`helpRows()`, verbatim:

```
"/help    print this list of commands"
"/think    show the last full thinking block"
"/status    show session id, event count, and context estimate"
"/compact    summarize the older conversation to free context"
"exit    leave the session\nkeys    enter sends · ctrl+J newline …"
```

Two separate faults.

**(a) The descriptions do not line up.** Each row is built as
`name + "    " + desc` — four spaces regardless of the name's length —
so `/help` starts its description at column 10 and `/compact` starts its
at column 13. A list whose second column wanders is harder to scan than
one with no second column at all.

**(b) ~~The last row is not a row.~~ WITHDRAWN.** I claimed the literal
`\n` in the last element was a defect. It is not: the only consumer is
`bodyLog`, which is `body.raw(text.split("\n"))` — the split is the
contract, stated in the comment above the row, and `exit` and `keys`
land as two rows by design. Checked before touching it, which is why it
was not touched.

## The fix, as landed

The rows became a `[name, desc]` table with one computed stop:
`max(displayWidth(name)) + 4`. Every description now begins at column
12. The embedded newline stays exactly where it was (see (b)), and the
`keys` sentence keeps its words — TUI2-R1 (D) froze the SENTENCE, not
the padding, and that distinction is now written into the code.

## Red before green

`packages/tui-cells/tests/dc12-help-and-keys.test.ts` — every
description begins at the same column, and the longest name still gets a
gap. Red at three distinct start columns; green at one.
