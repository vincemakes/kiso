# TODO — deferred registry ONLY

Ordering is NOT defined here. The current execution priority lives in
the owner's roadmap (outside the repo, by policy). Rounds add deferred
items here; resolved items move to the round record that delivered
them; nothing below is a commitment or a sequence.

## The 1.0 line — CLOSED (released as 1.0.0 in the R-I round, 2026-08-12)

- *(resolved in the 0.1.47 round — R-G, ADR-0050: the python3 flock
  helper is retired; the session store's single-writer lock is the
  native identity-confirmed link lock. The external review's risk #4,
  `docs/reviews/2026-08-06-external.md`, is closed.)*
- *(resolved in the 0.1.49 round — R-H, ADR-0051: the durable event
  union is frozen — the three classes (FROZEN / NORMALIZE / COMPACTED),
  the five evolution rules incl. the prefix-table closure and
  content-discernibility, the amendment ritual, the drift gates. The
  external review's risk #5 closed the day the freeze landed; the 1.0.0
  flip is the semver public promise of that ABI (ADR-0051 Amendment 1).)*

## Deferred items (unordered)

- *(resolved in the E1 round — the request trace shipped in 1.2.0-era
  runtime and is the standing observation ledger.)*
- **The planning eval** — the long-horizon planning evaluation, queued
  separately (per the 1.0 ruling); needs its own fixture + scenario set.
- **provider_deferred (the R-C item 5 parked design)** — the
  free-form `type: "custom"` tool payload for patch delivery (no JSON
  escaping); provider-layer work, four open questions recorded in the
  parked design, ~/Desktop/devv/parked-dscode-custom-tool.md.
- **Diet D re-discussion** — the diet-micro riders A/B/C landed in
  0.1.48 with D reverted (the 0.1.47 void adjudication); D's re-entry
  is an open discussion, not a commitment.
- **Plan the next core extraction (core at 1997/2000)** — registered by
  the 0.9.0 field-report audit (TUI2-R2pre ⑥): the kernel is 28 lines
  under its own budget, so the next feature that touches it has nowhere
  to land. What to extract is the open question — this line exists so
  the ceiling is a scheduled decision rather than a build failure
  somebody meets by surprise.

## P2 (found in 0.1.25 release verification) — CLOSED

- *(resolved in the E2 round — 1.3.0, the R2a-1 ruling 2026-08-13: the
  cache % that could render >100% on the anthropic-compat path. The
  mixed-convention consumer is CANONICAL at the route now
  (`canonicalizeUsage`, `apps/cli/src/chat.ts` — the declared
  existing-behavior change above `usageFromEvent`). The entry's own
  worked example is quoted back there: raw `{input 111, cacheRead 1024}`
  used to render "in 111" and a cache ratio of 923%; `in` is the
  canonical FRESH count now and the recap divides cache by the TOTAL
  (in + cache), which cannot exceed 100% by construction. The registered
  reproduction — anthropic-compat short session + `grep cacheRead` — is
  the trace block's own derivation.)*

## Standing (per-round)

- the todo extension (the interactive todo surface) — deferred each round per the
  spec; still deferred after TUI v5.
- the three-terminal on-device acceptance — the v4/v5 checklist tables in the round records; the
  human-terminal drag/screenshot items await the user's real terminals.
