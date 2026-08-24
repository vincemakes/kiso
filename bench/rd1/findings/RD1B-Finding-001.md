# RD1B-Finding-001 — the dock-less uncertainty question inverts the answer

- **id:** RD1B-F1
- **class:** decision-surface / answer-inversion
- **severity:** P1 — a truthful human answer causes the duplicate effect
  the whole uncertainty mechanism exists to prevent
- **agent:** kiso 0.15.1 (published) and every earlier version carrying
  the W21 fallback question
- **model:** deepseek-v4-flash (model-independent — this is CLI copy)
- **baseline:** bench f0090d7 (frozen batch), artifacts rd1b-kiso
- **scenarios:** c3-r1, c3-r2 (both runs)
- **status:** FIXED in the working tree; not in any released version.
  The RD-1B C3 FAIL stands permanently — it was a real defect meeting a
  real scenario.

## The chain

    packages/tui-cells/src/strings.ts   uncertainView().fallbackQuestion
      → "⚠ interrupted execution: <name> (<id>) — did it apply? (y)es / (n)o"
    apps/cli/src/trust-ui.ts:87         y → { action: "allow" }
    apps/cli/src/trust-ui.ts:345        allow → resolution "rerun"
    durable log                         tool_execution_resolved: "rerun"

The question asks about STATE; the mapping treats the answer as an
ACTION. So the honest answer inverts in both directions:

| the human sees | answers truthfully | kiso does | should do |
|---|---|---|---|
| the effect DID apply | yes | **rerun** | abandon |
| the effect did NOT apply | no | **abandon** | rerun |

## Why nothing caught it

The dock path was never wrong. Its rows are actions — "rerun it" /
"abandon it" — so a user with a dock ≥4 rows picks an unambiguous verb.
The fallback question is the entire interface only on a tty too small to
render the dock, which is exactly what the RD-1 driver runs (a 0-row
pty, the reproducible surface). Every existing test that touched this
path used the string as a *read anchor*, never as a claim about meaning.

The sibling view built in the same round has it right —
`unansweredAskView` asks "ask it again? (y)es / (n)o", naming the action
`y` performs. Of the four simple views, `uncertainView` was the only one
whose fallback question did not name `simpleOptions[0]`. That makes this
an oversight, not a design.

## What it cost the benchmark

RD-1B's first report read the C3 double-deploy as a *harness* defect and
proposed making the surrogate answer "no" when deploy-output.txt exists
— i.e. answer the English question falsely to get the desired action.
That would have violated the frozen surrogate policy (SCENARIOS.md: the
surrogate answers from *observable truth*), hidden a P1 product defect,
and left the benchmark unable to detect the same class again. The
surrogate was right; the product was wrong.

## The fix

Both questions ask the action now, keeping the uncertainty in the rule
line: "an interrupted execution may have applied — rerun it?" and
"⚠ interrupted execution: <name> (<id>) — rerun it? (y)es / (n)o". The
verdict mapping is untouched.

## Gates added

- `packages/tui-cells/tests/strings.test.ts` — the structural invariant
  for EVERY simple view: the dock-less question contains
  `simpleOptions[0]`, the action `y` performs. Red before green; only
  `uncertainView` failed it.
- `apps/cli/tests/rd1b-f1-dockless-uncertainty.test.ts` — the shipped
  CLI on a 1-row pty, both directions, asserted against the DURABLE LOG
  rather than the screen: `y` → `resolution: "rerun"`, `n` →
  `"abandoned"`. The screen is what lied.
- `bench/rd1/harness/selftest.py` (t7) — the surrogate answers the
  question it was ASKED. Both grammars, opposite answers over the same
  world, and an unknown grammar raises rather than guessing.

## Retest

Not re-run in this batch (owner ruling 2026-08-24: the fix is in no
released version, and the spec's evidence tier is released-only). C3
re-tests in the next batch against the release that carries the fix.
Because the driver now answers whichever question it is shown, a re-run
against 0.15.1 still reproduces this FAIL.
