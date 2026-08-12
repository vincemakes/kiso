# kiso-bench — same model, same tasks, three coding agents

Date: 2026-08-06 · model: **deepseek-v4-flash** for all three tools ·
kiso **0.1.27/0.1.28** (the token round's kiso cells, re-run on the
published artifacts — T2/T3 on 0.1.27, T4 on 0.1.28 after the harness
fix below; the 0.1.23/0.1.26-era runs remain in the notes) ·
pi (@mariozechner/pi-coding-agent 0.73.1) · Claude Code 2.1.223 (via
DeepSeek's Anthropic-compatible endpoint). 2 runs per cell (r1 = the first,
r2 = the second — each run is an independent fresh session); every run's
task verification passed for every tool — capability was equal on these
tasks, so the columns measure efficiency alone. kiso ran with `--mode
bypass` (the bench-allow extension + the bypass tier — the default tier's
ask flow cannot run headless).

**Accounting — corrected in the 0.1.23 fresh-mystery round.** The three
providers report "input" differently: kiso's `inputTokens` INCLUDES the
cache-hit prefix (DeepSeek convention); pi and Claude Code report fresh-only
input. The previous version of this document labeled kiso's total input as
"fresh" and summed input + cache as "raw total" — double-counting the cache
and producing a phantom "fresh ≈ system-prompt size" anomaly. The columns
below use the uniform definitions: **fresh** = the non-cache-hit input,
**total** = fresh + cached, **cost-wtd** = fresh + 0.1 × cached (0.1 is
DeepSeek's cache-hit price ratio, https://api-docs.deepseek.com/quick_start/pricing).
The per-tool accounting is pinned by `bench/tests/test_extract.py` so a
future edit cannot regress the labeling.

## T1-T3 + T4 (per-run; the mean row is the headline basis)

| task | tool | run | fresh | cached | total | cost-wtd | out | reqs | wall |
|------|------|----:|------:|-------:|------:|---------:|----:|----:|-----:|
| T1 read+answer | **kiso** | 1 | 196 | 2,176 | **2,372** | 414 | 161 | 2 | 5s |
| | | 2 | 196 | 2,176 | **2,372** | 414 | 163 | 2 | 5s |
| | **mean** | | 196 | 2,176 | **2,372** | **414** | 162 | 2.0 | 5.0s |
| | pi | 1 | 1,143 | 7,680 | 8,823 | 1,911 | 147 | 2 | 6s |
| | | 2 | 1,149 | 7,680 | 8,829 | 1,917 | 168 | 2 | 5s |
| | mean | | 1,146 | 7,680 | 8,826 | 1,914 | 158 | 2.0 | 5.5s |
| | claude | 1 | 25,911 | 25,856 | 51,767 | 28,497 | 225 | 2 | 6s |
| | | 2 | 25,941 | 25,728 | 51,669 | 28,514 | 227 | 2 | 6s |
| | mean | | 25,926 | 25,792 | 51,718 | 28,505 | 226 | 2.0 | 6.0s |
| T2 fix+verify | **kiso** | 1 | 1,628 | 4,480 | **6,108** | 2,076 | 255 | 4 | 7s |
| | | 2 | 351 | 5,760 | **6,111** | 927 | 257 | 4 | 6s |
| | **mean** | | 990 | 5,120 | **6,110** | **1,502** | 256 | 4.0 | 6.5s |
| | pi | 1 | 1,531 | 17,152 | 18,683 | 3,246 | 446 | 4 | 11s |
| | | 2 | 1,455 | 17,152 | 18,607 | 3,170 | 345 | 4 | 10s |
| | mean | | 1,493 | 17,152 | 18,645 | 3,208 | 396 | 4.0 | 10.5s |
| | claude | 1 | 26,607 | 78,464 | 105,071 | 34,453 | 652 | 5 | 13s |
| | | 2 | 26,432 | 77,952 | 104,384 | 34,227 | 641 | 4 | 14s |
| | mean | | 26,520 | 78,208 | 104,728 | 34,340 | 646 | 4.5 | 13.5s |
| T3 cross-file rename | **kiso** | 1 | 2,590 | 7,168 | **9,758** | 3,307 | 737 | 5 | 11s |
| | | 2 | 1,387 | 8,704 | **10,091** | 2,257 | 817 | 5 | 12s |
| | **mean** | | 1,989 | 7,936 | **9,925** | **2,782** | 777 | 5.0 | 11.5s |
| | pi | 1 | 1,709 | 23,552 | 25,261 | 4,064 | 806 | 5 | 14s |
| | | 2 | 1,547 | 22,016 | 23,563 | 3,749 | 697 | 5 | 12s |
| | mean | | 1,628 | 22,784 | 24,412 | 3,906 | 752 | 5.0 | 13.0s |
| | claude | 1 | 28,290 | 218,368 | 246,658 | 50,127 | 2,185 | 15 | 30s |
| | | 2 | 28,101 | 188,928 | 217,029 | 46,994 | 2,004 | 14 | 30s |
| | mean | | 28,196 | 203,648 | 231,844 | 48,561 | 2,094 | 14.5 | 30.0s |
| T4 skills (repo convention) | **kiso** | 1 | 2,239 | 8,448 | **10,687** | 3,084 | 834 | 5 | 15s |
| | | 2 | 623 | 9,472 | **10,095** | 1,570 | 664 | 5 | 11s |
| | **mean** | | 1,431 | 8,960 | **10,391** | **2,327** | 749 | 5.0 | 13.0s |
| | pi | 1 | 2,362 | 49,280 | 51,642 | 7,290 | 2,542 | 9 | 38s |
| | | 2 | 2,061 | 51,456 | 53,517 | 7,207 | 2,530 | 8 | 30s |
| | mean | | 2,212 | 50,368 | 52,580 | 7,249 | 2,536 | 8.5 | 34.0s |
| | claude | 1 | 30,129 | 296,704 | 326,833 | 59,799 | 4,001 | 14 | 61s |
| | | 2 | 30,457 | 278,272 | 308,729 | 58,284 | 4,467 | 14 | 47s |
| | mean | | 30,293 | 287,488 | 317,781 | 59,042 | 4,234 | 14.0 | 54.0s |

## T5 — the 8-turn session with kiso's mid-way /compact (per-run)

| tool | run | fresh | cached | total | cost-wtd | out | reqs | wall |
|------|----:|------:|-------:|------:|---------:|----:|----:|-----:|
| **kiso** | 1 | 7,249 | 118,656 | **125,905** | 19,115 | 4,823 | 34 | 92s |
| | 2 | 11,460 | 144,896 | **156,356** | 25,950 | 6,896 | 35 | 108s |
| | **mean** | | 9,354 | 131,776 | **141,130** | **22,532** | 4,860 | 34.5 | 100.0s |
| pi | 1 | 3,807 | 276,224 | 280,031 | 31,429 | 7,193 | 33 | 102s |
| | 2 | 5,227 | 242,176 | 247,403 | 29,445 | 7,103 | 32 | 89s |
| | mean | | 4,517 | 259,200 | 263,717 | 30,437 | 7,148 | 32.5 | 95.5s |
| claude | 1 | 30,894 | 739,456 | 770,350 | 104,840 | 9,912 | 31 | 118s |
| | 2 | 33,484 | 1,097,856 | 1,131,340 | 143,270 | 10,754 | 33 | 164s |
| | mean | | 32,189 | 918,656 | 950,845 | 124,055 | 10,333 | 32.0 | 141.0s |

## The 2026-08-12 three-way — the 1.0.0 candidate (per-run; medians are the headline basis)

The R-I launch-headline run: kiso 1.0.0 (the release candidate, tree
dist) · pi @earendil-works/pi-coding-agent **0.84.1** (npm latest —
renamed from the old 0.73.1, which is the 2026-08-06 doc's pi) · Claude
Code **2.1.227** (the local pin; npm latest 2.1.228). Same model
(deepseek-v4-flash), same fixtures, interleaved same-day runs with the
order shuffled per round. n=3 per tool on T3, n=2 per tool on T5; every
run verify=pass. Raw runs: `bench/runs/*-3way-*` (local; the runs
directory is gitignored — the numbers here and in the README are the
committed record). The per-tool invocation and the accounting are the
same files as the tables above; kiso ran `--mode bypass` with the
bench-allow extension.

| task | tool | run | fresh | cached | total | cost-wtd | out | reqs | wall |
|------|------|----:|------:|-------:|------:|---------:|----:|----:|-----:|
| T3 cross-file rename | **kiso** | 1 | 831 | 12,032 | **12,863** | 2,034 | 803 | 5 | 10s |
| | | 2 | 995 | 12,160 | **13,155** | 2,211 | 720 | 5 | 12s |
| | | 3 | 868 | 15,104 | **15,972** | 2,378 | 779 | 5 | 10s |
| | **median** | | 868 | 12,160 | **13,155** | **2,211** | 779 | 5.0 | 10.0s |
| | pi | 1 | 4,285 | 20,096 | 24,381 | 6,295 | 1,003 | 6 | 13s |
| | | 2 | 2,106 | 23,424 | 25,530 | 4,448 | 1,043 | 6 | 16s |
| | | 3 | 2,049 | 26,624 | 28,673 | 4,711 | 1,082 | 6 | 12s |
| | median | | 2,106 | 23,424 | 25,530 | **4,711** | 1,043 | 6.0 | 13.0s |
| | claude | 1 | 26,894 | 158,080 | 184,974 | 42,702 | 1,557 | 12 | 21s |
| | | 2 | 27,347 | 185,728 | 213,075 | 45,920 | 1,445 | 12 | 22s |
| | | 3 | 27,175 | 157,824 | 184,999 | 42,957 | 1,379 | 12 | 20s |
| | median | | 27,175 | 158,080 | 184,999 | **42,957** | 1,445 | 12.0 | 21.0s |
| T5 8-turn session | **kiso** | 1 | 6,208 | 125,312 | **131,520** | 18,739 | 4,843 | 31 | 68s |
| | | 2 | 6,781 | 143,616 | **150,397** | 21,143 | 5,138 | 32 | 81s |
| | **median** | | 6,494 | 134,464 | **140,958** | **19,941** | 4,990 | 31.5 | 74.5s |
| | pi | 1 | 4,062 | 170,752 | 174,814 | 21,137 | 6,008 | 30 | 78s |
| | | 2 | 5,101 | 210,816 | 215,917 | 26,183 | 6,976 | 31 | 80s |
| | median | | 4,582 | 190,784 | 195,366 | **23,660** | 6,492 | 30.5 | 79.0s |
| | claude | 1 | 29,379 | 801,408 | 830,787 | 109,520 | 10,067 | 31 | 92s |
| | | 2 | 29,779 | 1,015,808 | 1,045,587 | 131,360 | 10,309 | 29 | 135s |
| | median | | 29,579 | 908,608 | 938,187 | **120,440** | 10,188 | 30.0 | 113.5s |

**The headline ratios (median cost-weighted = fresh + 0.1×cached):**
T3 — kiso 2,211 vs pi 4,711 = **2.1×**, vs Claude Code 42,957 =
**19×**. T5 — kiso 19,941 vs pi 23,660 = **1.2×**, vs Claude Code
120,440 = **6.0×**.

**The protocol-generation note (why the 2026-08-10 11×/66× narrowed).**
The 2026-08-10 numbers (kiso 0.1.41: T3 cw 733) were measured BEFORE
the 0.1.45+ built-in extension layer and the trust surface; the same
protocol files now produce kiso T3 cells in the 2,000–2,400 band —
consistent with the 0.1.48 v2 re-baseline (2,068/2,191 in the in-repo
A/B series) and the 0.1.49 acceptance. pi also moved (8,074 → 4,711)
on the SAME version 0.84.1, so the shift is protocol/model-side, not a
kiso-specific change. The 2026-08-10 README table lives in git history.

Honest footnotes: serial runs (each later run rides the provider's
server-side warm cache — the fresh column is the unstable one); Claude
Code off-label (DeepSeek's Anthropic-compatible endpoint, prompts tuned
for Claude models); kiso is our own tool (reproduce it yourself); the
tasks are small — the large system prompts' real capability pays off on
complex work these tasks do not exercise.

## T6 — the 24-turn long curve (the divergence curve, per 6-turn bucket)

| tool | run | bucket | fresh | cached | total | cost-wtd | out | reqs | wall |
|------|----:|------:|------:|-------:|------:|---------:|----:|----:|-----:|
| **kiso** | 1 | 1 | 18,998 | 123,392 | **142,390** | 31,337 | 4,412 | 31 | 78s |
| | | 2 | 9,268 | 201,856 | **211,124** | 29,454 | 2,179 | 21 | 45s |
| | | 3 | 2,407 | 300,672 | **303,079** | 32,474 | 2,534 | 23 | 47s |
| | | 4 | 2,334 | 369,024 | **371,358** | 39,236 | 2,912 | 22 | 47s |
| | 2 | 1 | 1,566 | 60,928 | **62,494** | 7,659 | 2,783 | 20 | 49s |
| | | 2 | 1,832 | 128,128 | **129,960** | 14,645 | 2,573 | 20 | 44s |
| | | 3 | 1,627 | 190,848 | **192,475** | 20,712 | 2,431 | 20 | 44s |
| | | 4 | 4,721 | 444,288 | **449,009** | 49,150 | 7,775 | 30 | 92s |
| | mean | 1 | 10,282 | 92,160 | **102,442** | **19,498** | 3,598 | 26 | 64s |
| | | 2 | 5,550 | 164,992 | **170,542** | **22,049** | 2,376 | 20 | 44s |
| | | 3 | 2,017 | 245,760 | **247,777** | **26,593** | 2,482 | 22 | 46s |
| | | 4 | 3,528 | 406,656 | **410,184** | **44,193** | 5,344 | 26 | 70s |
| pi | 1 | 1 | 5,436 | 258,560 | **263,996** | 31,292 | 10,110 | 29 | 98s |
| | | 2 | 2,667 | 432,000 | **434,667** | 45,867 | 5,234 | 21 | 57s |
| | | 3 | 2,555 | 546,048 | **548,603** | 57,160 | 4,854 | 20 | 53s |
| | | 4 | 2,201 | 644,864 | **647,065** | 66,687 | 5,997 | 19 | 59s |
| | 2 | 1 | 2,783 | 121,856 | **124,639** | 14,969 | 3,137 | 21 | 41s |
| | | 2 | 1,735 | 199,552 | **201,287** | 21,690 | 3,506 | 20 | 41s |
| | | 3 | 1,803 | 281,088 | **282,891** | 29,912 | 4,386 | 19 | 46s |
| | | 4 | 3,203 | 427,264 | **430,467** | 45,929 | 5,571 | 21 | 56s |
| | mean | 1 | 4,110 | 190,208 | **194,318** | **23,130** | 6,624 | 25 | 70s |
| | | 2 | 2,201 | 315,776 | **317,977** | **33,779** | 4,370 | 20 | 49s |
| | | 3 | 2,179 | 413,568 | **415,747** | **43,536** | 4,620 | 20 | 50s |
| | | 4 | 2,702 | 536,064 | **538,766** | **56,308** | 5,784 | 20 | 58s |

**The divergence curve (per-bucket mean cost-weighted):**
kiso —→ b1 19.5K · b2 22.0K · b3 26.6K · b4 44.2K  (**2.27×** growth)
pi   —→ b1 23.1K · b2 33.8K · b3 43.5K · b4 56.3K  (**2.43×** growth)

**The finding:** both curves GROW steeply — every tool re-reads its
growing context, and the growth rate is nearly identical (2.27× vs
2.43× over a 4× longer session). kiso is cheaper at EVERY bucket
(1.19×–1.64×, total-session mean 112.3K vs 156.8K ≈ 1.4×), but the gap
does NOT compound — b4's 1.27× is back near b1's 1.19×. The
"divergence-of-divergence" hypothesis (kiso's savings grow as the
session does) is NOT confirmed: the durable-session design buys a
constant offset on the long curve, not compounding savings. That is a
finding, not a failure — the instrument did its job (the no-divergence
option was the honest null).

**What this measures:** cost GROWTH over a 24-turn session, not just
the total. Each tool drives the SAME 24 progressive turns on fixture-t6
(range/report/cli contract) with its NATIVE session mechanism:
kiso — 4 processes on ONE durable session, 6 piped prompts each. The
process boundaries ARE the bucket boundaries; the resume cost of a
process lands in its bucket's first turn (the mechanism's honest
price). No /compact anywhere — the curve measures UNCOMPACTED growth.
pi — 24 `-p` invocations sharing one --session file (its native
multi-turn mode); per-invocation walls summed per bucket.

**Accounting:** the uniform definitions pinned by
bench/tests/test_extract.py — kiso's inputTokens includes the cache-hit
prefix (fresh = input − cache_read, total = input); pi reports
fresh-only input (fresh = input, total = input + cache_read);
cost_weighted = fresh + 0.1 × cache_read (DeepSeek's cache-hit price
ratio). kiso's session log is cut at user_input events (input-then-
usage ordering, verified against the logs); walls come from the runner.

**Honest caveats:** (a) the runs are SERIAL — run 2 rides the
provider's server-side warm cache (b1 fresh: kiso 19.0K→1.6K, pi
5.4K→2.8K); the means average one cold + one warm start and the fresh
column is the unstable one. (b) kiso run 2 bucket 4 (92s, 30 reqs,
49.2K) — the final "verify everything" turn ran extra rounds;
run-level variance is real at n=2. (c) pi emits ~1.5–1.6× kiso's output
tokens (its per-invocation responses re-emit context). (d) versions:
kiso v0.1.41 (the global install, 2026-08-10), pi 0.84.1,
deepseek-v4-flash via each tool's native provider path, verify=pass
4/4.

## Headline

**Raw total input tokens:** kiso is 2.5× fewer than pi on T3 (9.9K vs
24.4K), 3.1× on T2 (6.1K vs 18.6K) and 5.1× on T4 (10.4K vs 52.6K) —
with identical task outcomes. T1 3.7× (unchanged, not re-run); the T5
long session 1.9× fewer than pi, 6.7× fewer than CC.

**Cost-weighted (fresh + 0.1×cached, DeepSeek's cache-hit price ratio):**
kiso is cheaper than pi on every scenario: T4 3.1× (2.3K vs 7.2K), T2
2.1× (1.5K vs 3.2K), T3 1.4× (2.8K vs 3.9K), T1 4.6× and T5 1.35×. The
0.1.22-era "pi overtakes ~2.7× on cost" headline was built on
double-counted kiso rows (see the correction below). Honesty rule
unchanged: the numbers are each provider's own, n=2, one fixture each,
and the T2/T3 fresh means carry the one-time cold start of the token
round's prompt change (see the 0.1.27/0.1.28 note).

**0.1.26 (the parallel-execution round):** the kiso T2-T4 rows were
RE-RUN on 0.1.26 (the windowed parallel execution, ADR-0024 Amendment 1).
The honest comparison then: the wall times were UNCHANGED within the LLM
variance — these tasks' tools are milliseconds-fast, so the wall IS the
model round-trips and the tool-execution overlap buys nothing measurable
(the parallel's measured win is where the tool LATENCY dominates: three
300ms tools complete in ~300ms instead of ~900ms — the synthetic gate in
packages/core/tests/parallel.test.ts, ①).

**0.1.27/0.1.28 (the token round — tool output discipline + request
contraction):** the kiso rows above are RE-RUN on 0.1.27 (T2/T3) and
0.1.28 (T4 — see the harness fix below). Two honest caveats on the T2/T3
fresh columns: (a) the r1 rows carry the one-time cold start of the
system-prompt change (the prompt's request-contraction guidance +3
bullets — the 0.1.26 r1 rows were warm because the prompt was
byte-identical to earlier batches); the r2 rows are the steady state
(T2 351 vs 223, T3 1,387 vs 1,450 — within variance). (b) The request
counts did not move on T2/T3 (4/5) — the contraction guidance changed
HOW the model reads (scoped ranges), not the round count on these small
tasks. T4 flipped decisively: **5 requests vs pi's 8.5** (13 at 0.1.26),
cost-weighted mean 2.3K vs pi 7.2K (3.1×), wall 13s vs pi 34s — see the
T4 note below for why the 0.1.26 T4 baseline was itself an artifact.

## The fresh-mystery — verdict of the 0.1.23 investigation

The 0.1.22-era bench reported "kiso's per-request fresh ≈ its system-prompt
size (~1.7K/req)" and opened a todo: a suspected D-region byte-instability in
the composed system prompt. The 0.1.23 round investigated with the
diagnosis of record — dump each outgoing request body
(`KISO_DUMP_REQUESTS=<dir>`, kept as a documented debug tool), byte-diff
consecutive requests (`bench/dumpdiff.py`), classify the first divergence
(at the older request's last-message end = healthy; inside an old message =
contract violation). Findings:

1. **The anomaly was a measurement bug, not a product bug.** The extractor
   labeled kiso's TOTAL input (which includes the cache-hit prefix) as
   "fresh" and summed input + cache as "raw total". Real fresh/req on the
   0.1.22 runs: 77-295 — the same order as pi's (≈326 on T3). Every run's
   per-request usage shows 82-99% cache hits; request 1's cached=1024 even
   shows the system prompt cache-hitting ACROSS sessions (it is byte-stable).
   The system prompt itself was never unstable.
2. **But the dump-diff DID find one real D-region request-level violation, in
   the OpenAI-compat adapter (0.1.22, the hand-feel round's C7 rule).** The
   adapter gated `reasoning_content` on the CURRENT turn: at every turn
   boundary the just-finished turn's assistant messages lost the field,
   re-rendering old history and breaking the byte prefix inside an old
   message. Empirically: 14-request real session, two breaks, both at turn
   boundaries, each followed by a request whose fresh jumped to ≈ the whole
   message history (49% cache vs the usual 90%+).
3. **Fix (0.1.23):** the field's presence is monotone — once any message
   carries reasoning, EVERY assistant message carries the field (its own
   reasoning, or ""); otherwise none does. Old reasoning is echoed (the
   provider-cache-stable shape; the echoed CoT is cache-hit at 0.1×, so the
   old "token waste" concern is obsolete under cache pricing); "" on old
   turns verified accepted by the real API (200 + 2560 cached tokens).
   After the fix, the same real session shows 0 breaks across 13
   consecutive-request pairs and 82-99% cache on every request, including
   the turn boundaries that used to break. Real OpenAI never produces
   reasoning → its requests never see the field (byte-identical to before).
   Contract wording extended in ADR-0026 Amendment 1 (the request-level
   invariant: request N+1 shares request N's bytes through the close of
   request N's last message — the maximal achievable prefix).
4. The todo is closed. The cost-weighted re-baseline: the tables above are
   the 0.1.22 runs re-extracted with the corrected accounting; the 0.1.23
   release re-runs kiso's cells on the published artifact (below).

## The new scenarios (what they measure)

**T4 (skills, progressive loading)**: the fixture gains a repo convention
documented ONLY in a SKILL.md (every src/ feature bumps the PATCH digit of
package.json — enforced by a bench-side check the tests do not reveal).
Each tool surfaced the skill through its NATIVE mechanism: kiso's skills
extension (index + read_skill), pi's `--skill` (index + read tool), Claude
Code's project skills (`.claude/skills/`). All three completed with the
convention applied (0.3.1 → 0.3.2 in every run).

**T4 honesty — the 0.1.27 disqualification investigation found the baseline was a harness bug.**
Through 0.1.26 the kiso runner's extension dir carried ONLY bench-allow —
the official skills extension was never loaded, so kiso's model had to
discover `.claude/skills/…/SKILL.md` by raw exploration: the 13-request
rows (and a 0.1.27 run that never found the skill at all) measured that
exploration cost, not the product. The runner now loads the skills
extension (run-one.sh), which is what the scenario always specified. On
the FIXED harness (0.1.28), the model reads the index line in its prompt
(r1 — the description alone carries the convention) or calls `read_skill`
(r2 — batched with its read): **5 requests, cost-weighted 2.3K mean, 13s
mean, both runs verified.** The investigation also surfaced a latent
product bug the harness exposed: a sync extension's tools were registered
both eagerly AND via the 0.1.26 live source, duplicating them in the
adapter's tool list (real API: "400 Tool names must be unique" — faux
tests never saw it); fixed in 0.1.28 (the registry's list() dedups, the
registered map wins — same rule as get()/has()).

**T5 (long session, /compact)**: 8 progressive turns on the fixture, then
a final verification. Each tool drove the session with its NATIVE
mechanism: kiso — three processes over one durable session with a
`/compact` (the model summary, ADR-0044) between turns 5 and 6; pi —
eight `-p` invocations sharing one `--session`; claude — eight `-p`
invocations sharing one `--resume` session (its auto-compact never fired
at these context sizes). Every run verified pass. The /compact's own
summary request is inside kiso's total. Note: T5 is the scenario that
exercises turn boundaries — the 0.1.22 kiso runs here carried the C7
boundary breaks (one cache break per user turn); the 0.1.23 re-run above
measures the fixed adapter (the released artifact's own short-session
check: 12 requests, 0 prefix breaks, cached 85-98%).

## History (the 0.1.7-era numbers — honest trajectory)

The 2026-08-04 run (kiso 0.1.7 · pi latest-then · Claude Code 2.1.221):

| task | tool | total in | out | reqs | wall |
|------|--------|-------:|-----:|----:|-----:|
| T1 | kiso | 2,375 | 126 | 2 | 4.0s |
| | pi | 8,901 | 156 | 2 | 4.0s |
| | claude | 50,871 | 227 | 2 | 9.5s |
| T2 | kiso | 5,536 | 275 | 4 | 6.5s |
| | pi | 18,660 | 325 | 4 | 7.5s |
| | claude | 103,291 | 708 | 4.5 | 13.5s |
| T3 | kiso | 9,534 | 788 | 5 | 9.5s |
| | pi | 24,665 | 836 | 5 | 11.0s |
| | claude | 202,989 | 2,278 | 15.5 | 30.5s |

The 0.1.7 headline read "2.6× fewer than pi, 21× fewer than CC". Under the
CORRECTED accounting the current headline is essentially the same ratio
(2.6× vs pi on T3 — kiso 9.5K → 9.5K, pi 24.7K → 24.4K) and 24.3× vs CC
(203K → 232K — CC grew). The intermediate 0.1.22-era claim that "kiso's T3
total nearly doubled 9.5K → 18.2K" was itself an artifact of the same
double count (input + cache instead of input) — the product did grow (the
modes round, the skills index, /compact help) but per-task input did not
materially move. The 0.1.7 "total in" = the input-only quantity, consistent
with the corrected columns above. The 0.1.7 bench also predated the modes
round — the current runner needs `--mode bypass` for kiso, which the old
runs did not. The 0.1.7 T2/T3 verify cells were not machine-verified (a
verify-script subshell bug made the pass case report "n/a"); the current
runner verifies every cell. The 0.1.7 numbers have no cost-weighted column
(the raw transcript data was not preserved).

## Read this honestly

- These tasks are SMALL. Claude Code's large system prompt buys real product
  capability (task tracking, richer exploration) that pays off on complex
  work these tasks do not exercise. Its 14.5 requests on T3 are it being
  thorough, not broken.
- Claude Code ran off-label (DeepSeek endpoint); its prompts are tuned for
  Claude models.
- n=2, one fixture per scenario, one model. Token accounting is normalized
  per provider convention (kiso = DeepSeek convention: input INCLUDES the
  cache-hit prefix, fresh = input − cached; pi/CC = fresh-only input; the
  columns are each provider's own numbers, unified into fresh/total/
  cost-wtd by the extractors — pinned by `bench/tests/test_extract.py`).
- The cost-weighted column assumes DeepSeek's cache-hit price ratio (0.1)
  applies to every tool's cache usage — an approximation, not a bill.
- T3's verify checks the code still works (the fixture's user.test.js
  passes pre-rename too) — the rename itself is NOT machine-checked; the
  transcripts show the renames happened in every run.
- kiso is our own tool. Reproduce it yourself: everything needed is in
  this directory.

## Reproduce

```
./run-one.sh <kiso|pi|claude> <T1|T2|T3|T4> <run-id>
./run-t5.sh <kiso|pi|claude> <run-id>
./run-t6.sh <kiso|pi> <run-id>    # the 24-turn long curve
python3 extract.py .          # T1-T4 (fresh/total/cost_weighted)
python3 extract-t5.py .       # T5
python3 extract-t6.py .       # T6 (per-bucket)
python3 -m unittest tests/test_extract.py   # the accounting contract
python3 dumpdiff.py <dump-dir>              # the request-prefix diagnostic
```

Requires: the three CLIs installed, a DeepSeek API key in
`~/.config/claude-deepseek/credentials.env` (DEEPSEEK_API_KEY).
Raw data: `runs/<tool>-<task>-<run>/` — each run's transcript, session
log (kiso), per-process logs (pi/claude), wall seconds, and verify verdict.

## The release-refresh protocol (v2, revised at the 0.1.46 review)

Every kiso release report carries a kiso-side refresh: **T3 cross-file
+ T5 long-session, BOTH cost metrics — tokens AND wall time.** Three
runs each, against the published bin, recorded in README's "kiso-side
basis" section. The **previous release's run band (not its mean)** is
the non-regression basis: a regression below the band, or movement OUT
of the band, is **blocker-class** — a hard stop awaiting adjudication
at review; in-band movement or improvement ships with the report
carrying "proposed, for the reviewer" and is adjudicated at review.
The T5 band's run-to-run spread is historically wide (1.15×–1.57×
across the 0.1.44–0.1.46 refreshes) — the reading matters as much as
the numbers, and the reading is the reviewer's to confirm.
