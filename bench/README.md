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
python3 extract.py .          # T1-T4 (fresh/total/cost_weighted)
python3 extract-t5.py .       # T5
python3 -m unittest tests/test_extract.py   # the accounting contract
python3 dumpdiff.py <dump-dir>              # the request-prefix diagnostic
```

Requires: the three CLIs installed, a DeepSeek API key in
`~/.config/claude-deepseek/credentials.env` (DEEPSEEK_API_KEY).
Raw data: `runs/<tool>-<task>-<run>/` — each run's transcript, session
log (kiso), per-process logs (pi/claude), wall seconds, and verify verdict.
