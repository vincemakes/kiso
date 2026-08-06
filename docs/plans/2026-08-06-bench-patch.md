# Bench 补丁 — cost-weighted 列 + r1/r2 拆行 + kiso fresh 待办 (no re-runs)

2026-08-06. Spec: "bench 补丁(docs+提取器,不重跑):1. 三张表各加
cost-weighted 列...;2. 从 bench/runs 原始数据拆 r1(冷)/r2(热)两行,解释
fresh 不对称;3. kiso fresh 偏高本身开一条待办调查。"

## 1. cost-weighted 列 + 双口径 headline

- Every table (T1-T3+T4, T5) gains `cost-wtd` = fresh + 0.1 × cached —
  the 0.1 ratio is DeepSeek's cache-hit price ratio
  (https://api-docs.deepseek.com/quick_start/pricing), noted in the table
  header and the extractors (`cost_weighted` field in extract.py /
  extract-t5.py).
- Headline is now dual-metric, both stated plainly:
  - raw total: kiso 1.3× fewer than pi (T3), 12.8× vs CC; T5 1.2×/4.5×.
  - cost-weighted: **pi overtakes ~2.7× on T3** (3,906 vs 10,398), 4.1× on
    T4, 4.0× on T5, 1.4× on T1. CC stays heaviest except T5-cw (kiso
    121.0K ≈ claude 124.1K).
- The framing in the README: "writing the opponent's win honestly is the
  point of this document" — the two metrics disagree because of the
  cache-hit structure, spelled out in the caveats.

## 2. r1 (cold) / r2 (hot) 拆行 + fresh 不对称解释

- The tables now show per-run rows (r1/r2) with a mean row per tool.
- Finding: the fresh asymmetry (kiso ~6× pi's fresh on T3) is present in
  BOTH runs — the runs are independent fresh sessions, so it is NOT r2
  riding on r1's leftover cache (no cell shows a systematic second-run
  discount; the r1→r2 deltas are noise-level). Conclusion: structural,
  not pollution — the mean basis and the r1-cold basis tell the same
  story on raw totals.
- The accounting caveat: all three report fresh/cached the same way
  conceptually (fresh = non-cache-hit input, cached = the cache-hit
  prefix) — the difference is the REQUEST STRUCTURE: pi's system prompt
  is small and its re-sent history cache-hits fully (fresh/req ≈ 326 on
  T3); kiso's per-request fresh ≈ its system prompt size (≈1.7K/req) —
  its prefix is not being cache-hit across requests.

## 3. kiso fresh 待办 (its own round)

> **待办**: kiso's system-prompt prefix is not cache-hit across requests.
> Symptom: per-request fresh ≈ the system prompt size in every scenario.
> Hypothesis: a byte-instability in the composed system prompt — the
> D 区 contract (byte-stable for the session's lifetime) would be
> violated if any source varies per request (the mode append, the skills
> index, an injected path/version). If confirmed: a real D 区 contract
> bug; fix in a dedicated round; the bench's cost-weighted column needs a
> re-run to re-baseline afterwards.

## Acceptance

- No re-runs: the 30 runs in `bench/runs/` are untouched; only docs +
  extractors changed.
- Raw data paths unchanged: `bench/runs/<tool>-<task>-<run>/`.
- Committed + pushed (clean-tree two lines).
