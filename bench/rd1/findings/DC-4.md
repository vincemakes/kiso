# DC-4 — every markdown heading level renders identically

- **id:** DC-4
- **class:** rendering / information loss
- **severity:** P3 — no crash, no wrong output; a document just arrives
  flat
- **agent:** kiso 0.15.12 (working tree)
- **found by:** dumping `renderMarkdown` while writing
  `packages/tui/design.md`
- **status:** FIXED (0.16.2 working tree)

## The measurement

`md.ts` `blockBody`, the heading case, keeps the text and discards the
level:

```ts
const m = HEADING.exec(b.lines[0] ?? "");
return wrap(`${p.bold}${inlineSpans(m?.[2] ?? …, p.bold)}${p.reset}`, W, "", "");
```

`m[2]` is the text after the hashes. The hash count — the level — is
never read. So `# Overview`, `## The fix` and `### Step 3` all render as
the same bold line, and a model's structured answer arrives with its
structure removed.

Under `NO_COLOR` or through a pipe, `p.bold` is empty, so a heading is
also indistinguishable from a paragraph.

## Not a bug, deliberately, until here

The mono discipline chose attributes over colour on purpose, and the
comment in place says so. That decision is sound and is not what this
finding disputes. What it disputes is discarding the level: hierarchy is
structure, and structure is exactly what the discipline says must carry
meaning when colour is stripped.

## The fix, as ruled and landed

The owner ruled for the reference implementation's scheme on
2026-08-27. The principle is better than the indentation I proposed:
**attributes carry the level while they can, and when they run out the
marker itself is shown.**

| level | rendering |
|---|---|
| 1 | bold + underline, marker stripped |
| 2 | bold, marker stripped |
| 3 and below | bold, and the `###` printed |

`underline` joins the palette as its second attribute member, on the
`italic` precedent: SGR 4 costs the alphabet nothing chromatic, and a
terminal without underlines simply draws the text.

**The residual, stated rather than buried.** Levels 1 and 2 are told
apart by an attribute alone, so through a pipe they are still identical
— this scheme meets the constraint from level 3 down, not from level 1.
Closing that would cost a dim rule under level 1, which is one line of
code and a visible design change; it was not ruled, so it was not done.

## Red before green

`packages/tui-cells/tests/dc4-md-shape.test.ts` — three levels render
three distinct rows; level 3 and below carry their own marker with the
SGR stripped; levels 1 and 2 are separated by the underline. Red on all
three before the change, because every level rendered identically.
