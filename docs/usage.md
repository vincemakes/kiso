# The canonical usage schema

The accounting contract of kiso (E2, 1.3.0). One derivation function,
one schema, one versioned pricing table — every surface that turns raw
usage into numbers derives from the same code path
(`packages/runtime/src/usage/canonical.ts`), so the CLI recap, the
request trace's `canonical` block, and the bench extractor can never
disagree on what a token cost.


> PH-1c note: when you inject an adapter DIRECTLY (the hero example's
> shape), declare `provider: "anthropic" | "openai-compat"` on the
> AgentDefinition too — without it, usage canonicalizes under the
> honest "adapter" route: the input convention falls back to `total`
> and `costUsd` is null (never a guessed rate). Cost itself keys on the
> MODEL via the metadata registry (`runtime/internal`,
> `lookupModelMetadata`): an unregistered or unpriced model is null by
> design.

## The pinned sentence

> **`input` is FRESH-ONLY. `total` is the derived quantity:**
> `total = input + cacheRead + cacheWrite`.

The two routes report "input" differently, and the convention is a
property of the **route**, not the provider (the R2a ruling). The
derivation keys on the route identity; unknown routes fall back to
`"total"` — exactly the incumbent guard's else-branch, preserved by
construction.

| route | input convention | meaning |
|---|---|---|
| `anthropic` | `fresh` | `input_tokens` excludes the cached prefix — recorded as-is |
| `openai-compat` | `total` | `prompt_tokens` includes the cached prefix — `fresh = input − cacheRead` |
| (unknown) | `total` | the guard's fallback identity (`"adapter"`) |

Because `input` is fresh-only and `cacheRead` can never exceed the
provider-reported total it is subtracted from (clamped at 0), the
cache ratio `cacheRead / total` is **structurally incapable of
exceeding 100%** — the >100% disease is impossible by construction.

## The canonical block

`canonicalizeUsage(route, raw, table?)` reduces the provider-raw
quartet to the closed 8-field set (exported — the signature is frozen
the moment it lands; changing it is a MAJOR ritual, the R4b-1 ruling).
The trailing `table` parameter is the injection slot (R5b-④a): the
R5a-1-commercial table rides it on day one, defaulting to the pinned
builtin v1 table below — a future injection never widens the frozen
signature.

| field | meaning |
|---|---|
| `input` | FRESH-ONLY input tokens (the pinned sentence) |
| `cacheRead` | cache-hit read tokens, as reported |
| `cacheWrite` | cache-creation tokens, `null` preserved (openai-compat honestly reports none) |
| `output` | output tokens |
| `reasoning` | reasoning tokens, `null` when the provider reports none |
| `costUsd` | USD from the versioned pricing table — **never reported without its (id, version) tuple**; `null` = the R5b-④c absent stamp (the table has no rate for this route — an injected table's hole is explicit absent, never backfilled from the builtin table). The builtin v1 table covers both real routes, so `null` is unreachable in-tree — but the type expresses it |
| `pricingTableId` | the table's identity (R5b-④b): `"builtin"` = the pinned in-repo table; injected tables carry their own id |
| `pricingTableVersion` | the table version the cost was computed with — a rate change is a version bump, never an edit |

The validator pins the block's internal consistency: `input +
cacheRead + cacheWrite` must equal the raw total, and the cost must
equal `priceFor(route, table)` applied to the four quantities (cost
epsilon 1e-6; a `null` cost is accepted — nothing to recompute
against). A version without a pinned table cannot produce a cost
(`pricingTableFor` throws); the version pin is scoped to the builtin
id — an injected table's version is the injector's accounting, the
ledger cannot know tables it does not carry.

## Pricing table v1

Freeze date **2026-08-13** (the E2 ruling). Rates are DeepSeek's
published rates
(https://api-docs.deepseek.com/quick_start/pricing) with the 0.1
cache-hit ratio the bench has used since the 0.1.23 round. Both
routes price identically.

| per 1M tokens | USD |
|---|---|
| input (fresh) | 0.27 |
| output | 1.10 |
| cache read | 0.027 |
| cache write | 0 (DeepSeek's automatic caching is not priced separately) |

> **"an approximation, not a bill."** — the caveat sentence from the
> bench README carries forward verbatim: the table is a bookkeeping
> approximation for comparisons and recaps, never an invoice.

## The derivation surfaces

Three consumers share the one code path:

- **The trace guard** (`packages/runtime/src/trace/guard.ts`) — every
  request record's `canonical` block is written at settle, keyed on
  the run's route. The trace is the durable record of what a request
  cost.
- **The CLI recap** (`apps/cli/src/chat.ts` `usageFromEvent`) — the
  miss estimate runs on the canonical TOTAL (fresh + cache): the
  overlap between turns lives in the cached region, so a fresh-only
  difference is always silent. On openai-compat the numbers are
  identical to the legacy formula; on anthropic the previously
  permanently-silent signal now fires (the R2a-1 heal).
- **The bench extractor** (`bench/extract.py`, `bench/extract-t5.py`)
  — reads the trace sidecar first; the canonical block's `input` is
  fresh on both routes. Rows carry the uniform shape: `input = fresh,
  total = fresh + cache, cost_weighted = fresh + 0.1 × cache`.

## Generation compat (R1d-1)

A v1 sidecar (written by 1.2.0) has **no canonical block** — it reads
as defaults at every consumer, never a crash. The version-dispatching
validators accept both generations (`TRACE_SCHEMA_VERSIONS = {1, 2}`),
and the extractor's v1 fallback uses the sidecar's `freshInput` —
already the guard's route-derived fresh, so the numbers line up with
the canonical reading. The E1 trace/purity gates only ADD cases for
the new generation; they never change a v1 assertion.
