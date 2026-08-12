# TODO — standing deferred work

Registered across rounds; linked from the README. Rounds add here, and
resolved items move to the round record that delivered them.

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

## The post-1.0 queue (honest, in order)

- **Efficiency Foundation — Request Trace first** (the queued first
  round after the 1.0 flip): lineage links land in the trace ledger
  (ADR-0051 §10) — outside the frozen correctness surface, so it builds
  without touching the contract; the trace surface carries lineage
  (ADR-0051 §2.4) and the efficiency counters live in the ledger's OUT
  class.
- **The planning eval** — the long-horizon planning evaluation, queued
  separately (per the 1.0 ruling); needs its own fixture + scenario set.
- **provider_deferred (the R-C item 5 parked design)** — the
  free-form `type: "custom"` tool payload for patch delivery (no JSON
  escaping); provider-layer work, four open questions recorded in the
  parked design, ~/Desktop/devv/parked-dscode-custom-tool.md.
- **Diet D re-discussion** — the diet-micro riders A/B/C landed in
  0.1.48 with D reverted (the 0.1.47 void adjudication); D's re-entry
  is an open discussion, not a commitment.

## P2 (found in 0.1.25 release verification)

- **cache % can render >100% on the anthropic-compat path** — DeepSeek's
  anthropic-compat endpoint reports `input_tokens` EXCLUDING the cached
  prefix (fresh-only: observed inputTokens 59/111 vs cacheRead 1024),
  while its openai-compat endpoint reports input INCLUDING cache (the
  0.1.23-established convention). The recap/status formula
  `cache/in` (correct for the openai convention; real Anthropic's
  input_tokens also includes the cached portion) then renders nonsense
  like `cache 923%`. Fix direction: a per-provider input convention
  signal (or the extractor's fresh/total split) feeding the recap's
  ratio; register the reproduction: anthropic-compat short session +
  `grep cacheRead`.

## Standing (per-round)

- the todo extension (the interactive todo surface) — deferred each round per the
  spec; still deferred after TUI v5.
- the three-terminal on-device acceptance — the v4/v5 checklist tables in the round records; the
  human-terminal drag/screenshot items await the user's real terminals.
