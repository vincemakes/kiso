# ADR-0029: An ask is answered by a human — no automated policy speaks for the human

- **Status:** Accepted (supersedes ADR-0028's ask routing, 2026-08-04)
- **Date:** 2026-08-04
- **Layer:** L2 Kernel (permission)

## Context

The E1 policy chain (ADR-0028, surface 1) defined `ask` as "the existing
human approval flow". The first implementation routed an ask through
`hooks.onPreTool` — the entry of that flow. The MCP bridge stage (③) exposed
the flaw: the CLI's static automated policy (`PERMISSION_POLICY`, default
deny for unknown tools) answered the ask for tools it had no rule for —
`mcp__*` calls were DENIED by a static rule the human never saw. An ask
whose semantic is "a HUMAN must decide" was being answered by a program.

The MCP e2e required an approval prompt for `mcp__` tools, and the
"four packages zero diff" clause of ③ made the fix impossible without a
ruling: the conflict was between the e2e acceptance (prompt appears) and
the zero-diff clause (the ask path lives in the kernel loop).

## Decision (裁决 A)

**An ask means "a human must decide" — it routes DIRECTLY to the human
approval pause (`permission_requested` + `resolveApproval`), never through
`onPreTool`.** A static automated policy must not answer for the human; the
hook's gate in the loop is now `chainVerdict === undefined` — the ask is
resolved entirely by the pause, and the hook never re-consults it (no
double pause). The "ask with no human flow = honest denial" judgment keys
on `resolveApproval`'s presence, not the hook's.

The three options considered were: **A** — the ask goes directly to the
human pause (a core change, breaking the ③ zero-diff clause); **B** — keep
zero kernel diff and re-assert the e2e as "the ask tier denies by default"
(the human would never see external tools — "must pass human review"
becomes false); **C** — change the CLI's default policy to defer (a
product-wide security behavior change for ALL unknown tools). A was chosen
because it honors the semantic core ("external tools must pass human
review"), matches the e2e's letter, and is a correction of E1's own ask
semantics — not an exception carved out for MCP. The monotonicity family
(ADR-0028, surface 7) is untouched: the chain's deny>ask>allow order is
unchanged; ask simply no longer yields to the automated gate.

## Consequences

- An ask ALWAYS reaches a human prompt (or degrades honestly when no
  channel exists). The CLI's static deny now governs only calls the policy
  chain did not ask about — the ask outranks the default deny, by design.
- The extension surfaces that previously "fell into the human flow" via
  the hook now reach it directly; the hook is consulted only when no
  policy chain ran.
- Known cost: a policy extension can force human review of a call the
  host's automated policy would have denied — the human is the final gate
  at the prompt (they can deny there). This is the intended reading of
  "must pass human review", and it is recorded here so the trade is not
  re-litigated silently.

## When to revisit

A headless host that wants automated policies to outrank extension asks
would need a policy precedence rule — currently refused: the human is the
final gate by design.

## Evidence

- Commit `530ffc5` (fix(core): 裁决 A — E1 ask 语义修正); the full conflict
  and three-option analysis is recorded in `docs/plans/2026-08-04-
  extensions-e1.md` §7.
- Tests: `packages/core/tests/extensions.test.ts` — `裁决 A: ask with a
  hook but NO approval channel still degrades — the static hook never
  speaks for an ask`; the ask-routing tests (human pause, no decidedBy);
  `packages/runtime/tests/extensions.test.ts` — the static default-deny
  regression pin.
