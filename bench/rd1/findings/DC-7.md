# DC-7 — an OSC reply from the terminal lands in the composer as text

- **id:** DC-7
- **class:** input parsing
- **severity:** P2 on its own; a hard precondition for DC-3
- **agent:** kiso 0.16.2
- **found by:** checking what the editor would do with an OSC 11 answer
  before designing the ground probe
- **status:** FIXED for the editor (`packages/tui/tests/dc7-osc-swallow.test.ts`,
  8 cases): an OSC reply is swallowed rather than typed into the draft,
  and `apps/cli/src/index.ts` routes the ground query through the editor
  BECAUSE it is the process's single reader of stdin — this finding is
  cited there as the reason.

  THE FAMILY IS NOT CLOSED. The defect is not the editor's; it belongs to
  any reader of stdin that does not expect a terminal to answer back. It
  recurred once outside the editor: `kiso login` / `logout` / `auth` read
  with a prompt of their own, and an OSC reply landed in it. That instance
  is OR-3 (`d3f2e64`), fixed with its own gate
  (`apps/cli/tests/auth-tty.test.ts`). A second reader of stdin is the
  precondition; whoever adds the next one inherits this.

## The measurement

Feeding the exact bytes Apple Terminal answers with:

```
feed("\x1b]11;rgb:ffff/ffff/ffff\x07")  → composer line = "]11;rgb:ffff/ffff/ffff"
feed("\x1b]11;rgb:ffff/ffff/ffff\x1b\\") → composer line = "]11;rgb:ffff/ffff/ffff\\"
feed(reply + "hi")                       → composer line = "]11;rgb:ffff/ffff/ffffhi"
```

The reply is typed into the user's draft.

## The cause

`feed()`'s escape dispatch has a branch for `ESC [` (CSI), one for
`ESC O` (SS3), one for `ESC CR` (Alt+Enter) — and nothing for `ESC ]`.
An OSC therefore falls through to the literal-text path, `ESC` is
dropped and the rest of the sequence is inserted.

## Why it is a defect today, before any probe exists

kiso never sends an OSC query, but it is not the only thing that can
produce one. Terminals send unsolicited OSC on theme changes and other
state reports, and a multiplexer can forward one at any moment. This is
the same latent shape as the SGR-1006 mouse report documented in
`feed()` itself: a sequence class with no branch, harmless only for as
long as nothing emits it.

## The fix

An `ESC ]` branch that consumes to the terminator — **BEL or ST, both**,
since Apple Terminal answers with BEL — and parks an incomplete sequence
in `#pending`, which is the existing chunk-split mechanism the CSI
branch already uses. Recognised replies are handed to a callback;
everything else is discarded rather than typed.

## Red before green

Feed each of the three byte strings above and assert the composer stays
empty, including when the reply is split across two chunks at every
possible boundary.
