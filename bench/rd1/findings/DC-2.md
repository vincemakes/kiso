# DC-2 — the panel keys row truncates mid-word, silently

- **id:** DC-2
- **class:** rendering / truncation
- **severity:** P2 — the tree forbids this explicitly elsewhere
- **agent:** kiso 0.15.12 (working tree)
- **found by:** dumping `keysSheetRows(72)` while writing
  `packages/tui/design.md`
- **status:** FIXED (0.16.2 working tree)

## The measurement

`PANEL_KEYS_ROW` is 76 columns:

```
panels: ↑↓ move · ⏎ or click confirms · 1-4 instant · space toggles · t types
```

`keysSheetRows(72)` returns it cut to:

```
panels: ↑↓ move · ⏎ or click confirms · 1-4 instant · space toggles · t
```

`t types` becomes `t`, and there is no ellipsis. The reader is told a
key called `t` exists and is not told what it does — worse than being
told nothing, because the row looks complete.

## Why this is a rule violation and not a preference

The product already decided this. `widthCut` exists precisely to mark a
cut, the W14 fold line carries "the honest `…` (never a silent
truncate)", and the same principle is written into the turn fold and the
user chip's `+N more lines · sent in full`. This row predates the rule
being applied consistently.

## The fix, as landed

Both halves of the proposal, in order. `panelKeysRow(W)` drops whole
` · ` clauses from the end until the row fits, and `cutRow` — which
returned the surviving prefix with nothing to mark it — now costs a
column and appends `…` when it has to cut at all. Measured:

```
 76 | panels: ↑↓ move · ⏎ or click confirms · 1-4 instant · space toggles
 60 | panels: ↑↓ move · ⏎ or click confirms · 1-4 instant
 44 | panels: ↑↓ move · ⏎ or click confirms
 12 | panels: ↑↓ …
```

The ellipsis is the floor, for a width that cannot hold even the first
clause. `cutRow` is shared by every sheet row, so the mark arrived
everywhere at once — which is the correct blast radius for a rule the
tree already stated and this function alone was breaking.

## Red before green

`packages/tui-cells/tests/dc12-help-and-keys.test.ts` — for every width
in 40..80 the row is a run of whole clauses from the front, never ends
in a one-character clause, and never overruns. Red at 72 with `· t `.
