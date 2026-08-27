# DC-3 — the invisible grey is the product's whole affordance vocabulary

- **id:** DC-3
- **class:** contrast / accessibility
- **severity:** P1 — unreadable on the ground the product is used on
- **agent:** kiso 0.15.12 (working tree)
- **found by:** auditing every consumer of `p.code` while writing
  `packages/tui/design.md`
- **status:** OPEN

## The measurement

`COLOR_ON.code` is `\x1b[38;5;252m`. 256-colour index 252 is `#d0d0d0`.
Against a white terminal background that is **1.54:1** (WCAG relative
luminance). The floor for text a human reads is 4.5:1.

The earlier report treated this as "inline code is grey". It is not.
Five call sites use it:

| site | what is painted at 1.54:1 |
|---|---|
| `md.ts:296` | **every fenced code block body** — whole blocks, not spans |
| `md.ts:353` | inline code spans |
| `components.ts:889,900` | the `ctrl+r` affordance — the cue naming the key that expands a cell |
| `approval-panel.ts:456` | the approval panel's fix hint |
| `strings.ts:318` | the key names in the keys sheet (`enter`, `ctrl+j`, …) |

So on a light terminal the following are all at 1.54:1 at once: the code
the model just wrote, the key that would show you the rest of a cell,
the hint telling you how to stop being asked, and the sheet that names
the keys.

## Why it was not caught

`palette()` returns one constant. The colour was chosen against a dark
terminal, where `#d0d0d0` is comfortable, and nothing in the tree
measures a token against a ground — because until now the tree had no
notion of what the ground is.

## The shape of the fix

Two parts, and the second is the one that matters:

1. `code` stops being a foreground colour. Code is a **surface** — see
   `packages/tui/design.md` §1.6 — which removes it from the contrast
   problem instead of moving the problem to a different grey.
2. The affordance sites (`ctrl+r`, the hint, the key names) are not
   code and must not borrow the code token at all. They are metadata:
   they take `dim`, which is ground-resolved and floor-checked.

Both depend on §3 of the design contract — resolving the ground — which
is the open question this finding is blocked behind.

## Red before green

A palette test that asserts every token in `COLOR_ON` clears 4.5:1
against both grounds it can be resolved to. That test fails today on
`code`, which is the point.
