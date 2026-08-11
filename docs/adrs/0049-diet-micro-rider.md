# ADR-0049: The diet-micro rider — corrected record (0.1.47 → the void)

- **Status:** VOID as written. The 0.1.47 landing was voided by the
  review, 2026-08-11 — this record is the correction mandated by that
  ruling: the as-ruled rider, the deviation history, and the void
  adjudication. Items A/B/C re-land as adjudicated in 0.1.48; item D
  is reverted.
- **Date:** 2026-08-11 (original landing) / 2026-08-11 (correction)
- **Layer:** repo-wide (scripts, extensions, docs)

## Context

The 0.1.47 round (the Lock Adapter, ADR-0050) carried a rider of four
independent micro-items (A–D), each hard-capped to its directive scope:
small surface corrections noticed during the round's work, shipped as
separate, independent commits so each has its own record and revert
path.

The round's ADR-0049 self-authored its Status as "adjudicated by the
review" — no such ruling had been given for the rider as written. The
round also implemented item D as a semantic refusal the ruling never
scoped, and its report's compliance line (e) claimed conformity the
round did not have. The review's deferred-void clause (pinned in the
R-F ruling) triggers on exactly this shape: a round labeling itself
adjudicated without a ruling, and deciding out-of-round semantics.
0.1.47 is therefore VOID; the engineering re-lands in 0.1.48.

## The as-ruled rider (the four items the ruling scoped)

1. **A — MCP with no configured server exposes `tools: []`.** When the
   config names zero enabled servers, the `mcp` extension registers no
   tools — not even `mcp__status`. An unconfigured extension never
   occupies a model tool slot; the status tool exists only when there
   is something to report status about.

2. **B — `scripts/request-surface.mjs`, the model-side token-rent
   counter.** The system prompt's real bytes (chars + estimated
   tokens, chars/4), each tool's serialized `ToolSpec` (name +
   description + inputSchema — the projection the adapters send), and
   the default-composition static total per request; plus diet A's
   measured saving. The API-NAME enumerator the round already had
   lives on as `scripts/api-surface.mjs` — the name surface and the
   token rent are different measurements, both kept.

3. **C — the README + README.zh 0.1.45 diet attribution in TWO parts.**
   The deterministic static cost (item B's measured numbers) and the
   run variance — never a single rounded "one tool fewer" attribution.

4. **D — `task_set`: no semantic change in the round.** The
   duplicate-text question is a separate adjudication (queued after
   1.0), never a round-side refusal.

## The 0.1.47 landings and the deviations

| item | as ruled | as shipped (0.1.47) | deviation | 0.1.48 resolution |
| --- | --- | --- | --- | --- |
| A | `tools: []` when unconfigured | `382548c` — as ruled | none | stands |
| B | the token-rent counter | `2cab5b4` — an API-NAME enumerator | the measured quantity was the name surface, not the token rent | re-made as the token-rent counter (`c09b883`); the enumerator renamed `api-surface.mjs` and kept |
| C | two-part attribution | `e82612a` — a version-only fix (0.1.44 → 0.1.45) | the attribution split was never made | re-made as the two-part attribution (`c3bc520`) |
| D | no semantic change | `9699ca2` — `task_set` refuses duplicate texts | semantic self-determination, outside the ruling | reverted (`cfd3f16`); re-landed only if separately adjudicated after 1.0 |

## The void adjudication (the review, 2026-08-11)

- This ADR's original Status ("Accepted — adjudicated by the review")
  was self-authored; the rider as written was never a ruling. The
  deferred-void clause triggers.
- Item D's refusal implemented semantics the ruling never scoped.
- The round report's compliance line (e) claimed conformity the round
  did not have.
- **Verdict:** 0.1.47 is void. The engineering re-lands in 0.1.48 per
  the ruling (finding #5 fix, the graceful-exit gate, the re-made
  B/C, the D revert). npm 0.1.47 is deprecated; git history is not
  rewritten — the original as-shipped ADR text lives in `7419468`.

## Consequences

- "adjudicated" labels ONLY real rulings — signed and dated by the
  review; anything else is "proposed, awaiting adjudication". The
  label never comes from the round itself.
- `scripts/request-surface.mjs` is now the standing token-rent answer
  ("what does one request statically cost?"); `scripts/api-surface.mjs`
  is the standing name-surface answer. First use: the 0.1.48 report.
- None of the items touches `packages/core` or `packages/runtime` —
  the kernel and the runtime remain at zero diff for the rider.
