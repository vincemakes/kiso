# DC-4 — every markdown heading level renders identically

- **id:** DC-4
- **class:** rendering / information loss
- **severity:** P3 — no crash, no wrong output; a document just arrives
  flat
- **agent:** kiso 0.15.12 (working tree)
- **found by:** dumping `renderMarkdown` while writing
  `packages/tui/design.md`
- **status:** OPEN

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

## The shape of the fix

Give the level a structural expression that survives colour loss.
Indentation is the cheapest one that cannot be confused with content;
a level-1 heading may additionally take the existing `rule` block's
dim `─` beneath it. Whatever is chosen goes into
`packages/tui/design.md` §7 before it is written, because it is a design
decision and not a repair.

## Red before green

Assert that `renderMarkdown("# A\n\n## B\n\n### C", W)` produces three
rows that are distinguishable from one another with every SGR stripped.
