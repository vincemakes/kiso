# ADR-0042: `abstain` — a policy's no-opinion verdict; all-abstain falls to the human

- **Status:** Accepted
- **Date:** 2026-08-05
- **Layer:** packages/core (the E1 approval chain), apps/cli (the mode tiers)

## Context

The Modes round (2026-08-05) introduced five built-in approval tiers as
`mode:<name>` extensions on the E1 approval chain. Only the CURRENT tier
should speak per call; the others had to express "no opinion". The only
available verbs were `allow` / `ask` / `deny` — so no-opinion was encoded
as `allow`, and the `default` tier's unknown-tool branch ("an
extension-provided tool is the extensions' business") also returned
`allow`.

P2 review found the defect: `allow` is a REAL verdict in the chain's
composition (deny > ask > allow over ALL policies; an all-allow chain
auto-approves and records `decidedBy = approvalPolicies[0]`). Encoding
"no opinion" as `allow` therefore:

1. **Silently auto-approved tools no policy meant to approve** — a user
   with mcp/subagent installed but WITHOUT safe-defaults saw every
   `mcp__*` call execute with zero human review (the bare-install e2e
   turned red on exactly this), and
2. **Misattributed the audit trail** — those auto-approvals recorded
   `decidedBy: "mode:default"`, a tier that never spoke.

Root cause: the E1 chain had no abstention verb — `allow` was overloaded
with "no opinion".

## Decision

1. `PolicyVerdict` gains `{ action: "abstain" }` — a policy's NO opinion:
   it neither allows, denies, nor asks.
2. The chain composes deny > ask > allow over the SPEAKING verdicts only
   (`abstain` is skipped). An all-abstain chain is a silent chain — it
   falls to the ask flow: with an approval channel configured, the call
   ASKS the human (裁决 A semantics — the tool still meets the human);
   without one, the honest denial (the ask-without-channel degradation).
   Abstaining is never a silent allow.
3. `decidedBy` records only a SPEAKER — the denying extension for a
   denial, the FIRST non-abstaining extension for an all-allow chain —
   never the chain head on behalf of a non-speaker.
4. A policy that throws still counts as `ask` (it SPEAKS — degradation
   to abstain would silently re-open the hole).
5. The mode tiers abstain when they are not current and when the current
   tier has no opinion (unknown/extension-provided tools in
   `default`/`accept-edits`). `bypass` returns a REAL `allow` — the
   neutral tier for headless children (the subagent extension spawns
   children with `KISO_MODE=bypass`, where the role policies' allow/deny
   remain the only gate).

## Consequences

- Bare installs (mcp/subagent/skills without safe-defaults): external
  tools meet the human again — "unknown must pass a human" restored.
- Compatible surfaces (verified by the suite, 524 green): safe-defaults
  ("everything else → ask"), user-written allow-mcp policies
  (mode abstain + user allow → allow, decidedBy = the user extension),
  bench-allow all-allow, subagent role policies, and the 裁决 A
  ask-through tests — none needed changes.
- **Stop-clause lesson (reaffirmed into the round plan):** retiring any
  DELIBERATE default/fallback whose deliberateness is documented (in a
  comment or an ADR) belongs to the stop-and-ask-for-ruling scope. The
  Modes round encoded `allow`-as-no-opinion with a comment that proved
  the deliberation ("the tier neither allows nor denies") and should
  have stopped instead of shipping the overloading.
