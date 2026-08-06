# kiso-bench — same model, same tasks, three coding agents

Date: 2026-08-06 · model: **deepseek-v4-flash** for all three tools ·
kiso 0.1.22 · pi (@mariozechner/pi-coding-agent 0.73.1) · Claude Code
2.1.223 (via DeepSeek's Anthropic-compatible endpoint). 2 runs per cell
(r1 = the first, r2 = the second — each run is an independent fresh
session); every run's task verification passed for every tool — capability
was equal on these tasks, so the columns measure efficiency alone.
kiso ran with `--mode bypass` (the bench-allow extension + the bypass tier
— the default tier's ask flow cannot run headless).

**cost-wtd** = fresh + 0.1 × cached — the cost-weighted input: 0.1 is
DeepSeek's cache-hit price ratio (cache-hit tokens bill at 10% of the
cache-miss price, https://api-docs.deepseek.com/quick_start/pricing).

## T1-T3 + T4 (per-run; the mean row is the headline basis)

| task | tool | run | fresh | cached | raw total | cost-wtd | out | reqs | wall |
|------|------|----:|------:|-------:|----------:|---------:|----:|----:|-----:|
| T1 read+answer | **kiso** | 1 | 2,372 | 2,176 | **4,548** | 2,590 | 98 | 2 | 4s |
| | | 2 | 2,372 | 2,176 | **4,548** | 2,590 | 171 | 2 | 5s |
| | **mean** | | 2,372 | 2,176 | **4,548** | **2,590** | 134 | 2.0 | 4.5s |
| | pi | 1 | 1,143 | 7,680 | 8,823 | 1,911 | 147 | 2 | 6s |
| | | 2 | 1,149 | 7,680 | 8,829 | 1,917 | 168 | 2 | 5s |
| | mean | | 1,146 | 7,680 | 8,826 | 1,914 | 158 | 2.0 | 5.5s |
| | claude | 1 | 25,911 | 25,856 | 51,767 | 28,497 | 225 | 2 | 6s |
| | | 2 | 25,941 | 25,728 | 51,669 | 28,514 | 227 | 2 | 6s |
| | mean | | 25,926 | 25,792 | 51,718 | 28,505 | 226 | 2.0 | 6.0s |
| T2 fix+verify | **kiso** | 1 | 5,429 | 5,120 | **10,549** | 5,941 | 294 | 4 | 8s |
| | | 2 | 5,551 | 5,248 | **10,799** | 6,076 | 360 | 4 | 7s |
| | **mean** | | 5,490 | 5,184 | **10,674** | **6,008** | 327 | 4.0 | 7.5s |
| | pi | 1 | 1,531 | 17,152 | 18,683 | 3,246 | 446 | 4 | 11s |
| | | 2 | 1,455 | 17,152 | 18,607 | 3,170 | 345 | 4 | 10s |
| | mean | | 1,493 | 17,152 | 18,645 | 3,208 | 396 | 4.0 | 10.5s |
| | claude | 1 | 26,607 | 78,464 | 105,071 | 34,453 | 652 | 5 | 13s |
| | | 2 | 26,432 | 77,952 | 104,384 | 34,227 | 641 | 4 | 14s |
| | mean | | 26,520 | 78,208 | 104,728 | 34,340 | 646 | 4.5 | 13.5s |
| T3 cross-file rename | **kiso** | 1 | 10,659 | 9,728 | **20,387** | 11,632 | 788 | 6 | 12s |
| | | 2 | 8,410 | 7,552 | **15,962** | 9,165 | 650 | 5 | 11s |
| | **mean** | | 9,534 | 8,640 | **18,174** | **10,398** | 719 | 5.5 | 11.5s |
| | pi | 1 | 1,709 | 23,552 | 25,261 | 4,064 | 806 | 5 | 14s |
| | | 2 | 1,547 | 22,016 | 23,563 | 3,749 | 697 | 5 | 12s |
| | mean | | 1,628 | 22,784 | 24,412 | 3,906 | 752 | 5.0 | 13.0s |
| | claude | 1 | 28,290 | 218,368 | 246,658 | 50,127 | 2,185 | 15 | 30s |
| | | 2 | 28,101 | 188,928 | 217,029 | 46,994 | 2,004 | 14 | 30s |
| | mean | | 28,196 | 203,648 | 231,844 | 48,561 | 2,094 | 14.5 | 30.0s |
| T4 skills (repo convention) | **kiso** | 1 | 26,458 | 24,448 | **50,906** | 28,903 | 1,381 | 10 | 23s |
| | | 2 | 27,363 | 24,704 | **52,067** | 29,833 | 1,407 | 11 | 21s |
| | **mean** | | 26,910 | 24,576 | **51,486** | **29,368** | 1,394 | 10.5 | 22.0s |
| | pi | 1 | 2,362 | 49,280 | 51,642 | 7,290 | 2,542 | 9 | 38s |
| | | 2 | 2,061 | 51,456 | 53,517 | 7,207 | 2,530 | 8 | 30s |
| | mean | | 2,212 | 50,368 | 52,580 | 7,249 | 2,536 | 8.5 | 34.0s |
| | claude | 1 | 30,129 | 296,704 | 326,833 | 59,799 | 4,001 | 14 | 61s |
| | | 2 | 30,457 | 278,272 | 308,729 | 58,284 | 4,467 | 14 | 47s |
| | mean | | 30,293 | 287,488 | 317,781 | 59,042 | 4,234 | 14.0 | 54.0s |

## T5 — the 8-turn session with kiso's mid-way /compact (per-run)

| tool | run | fresh | cached | raw total | cost-wtd | out | reqs | wall |
|------|----:|------:|-------:|----------:|---------:|----:|----:|-----:|
| **kiso** | 1 | 123,546 | 113,792 | **237,338** | 134,925 | 4,458 | 34 | 92s |
| | 2 | 97,810 | 91,648 | **189,458** | 106,975 | 4,640 | 33 | 71s |
| | **mean** | | 110,678 | 102,720 | **213,398** | **120,950** | 4,549 | 33.5 | 81.5s |
| pi | 1 | 3,807 | 276,224 | 280,031 | 31,429 | 7,193 | 33 | 102s |
| | 2 | 5,227 | 242,176 | 247,403 | 29,445 | 7,103 | 32 | 89s |
| | mean | | 4,517 | 259,200 | 263,717 | 30,437 | 7,148 | 32.5 | 95.5s |
| claude | 1 | 30,894 | 739,456 | 770,350 | 104,840 | 9,912 | 31 | 118s |
| | 2 | 33,484 | 1,097,856 | 1,131,340 | 143,270 | 10,754 | 33 | 164s |
| | mean | | 32,189 | 918,656 | 950,845 | 124,055 | 10,333 | 32.0 | 141.0s |

## Headline — TWO metrics, honestly

**Raw total input tokens (the naive bill-of-quantity):** kiso is 1.3×
fewer than pi on T3 (18.2K vs 24.4K) and 12.8× fewer than Claude Code —
with identical task outcomes. On the T5 long session: 1.2× fewer than pi,
4.5× fewer than CC.

**Cost-weighted (fresh + 0.1×cached, DeepSeek's cache-hit price ratio):**
pi overtakes kiso — **~2.7× cheaper on T3** (3.9K vs 10.4K), 4.1× on T4,
4.0× on T5, 1.4× on T1. Claude Code remains the heaviest on every metric
except T5-cost-weighted, where kiso (121.0K) and claude (124.1K) are
within 3%.

The two metrics disagree because of the **cache-hit structure**: pi
re-sends its whole history as cache (fresh stays near the new-content
size per request), while kiso's fresh per request ≈ its system-prompt
size — its prefix is not being cache-hit across requests (see the
investigation below). Writing the opponent's win honestly is the point of
this document: on raw quantity kiso leads; on billed cost pi leads.

## The fresh asymmetry — r1 (cold) / r2 (hot) and what it means

Every cell shows the same shape in BOTH runs: kiso's fresh is ~6× pi's on
T3 (r1: 10,659 vs 1,709 — the runs are independent fresh sessions, so
this is NOT r2 riding on r1's leftover cache). The r1→r2 deltas are
noise-level (claude T1: r2 +2 fresh; kiso T3: r2 −2.2K fresh; no cell
shows a systematic second-run discount). Conclusion: the asymmetry is
structural, not inter-run pollution — the headline basis (the mean) and
the r1-cold basis tell the same story on raw totals.

**Why the fresh differs** (the accounting, each provider's own): all three
report fresh/cached the same way conceptually (fresh = the tokens the
provider did not cache-hit; cached = the cache-hit prefix). The
difference is the REQUEST STRUCTURE: pi's system prompt is small (~1.5K)
and its re-sent history cache-hits fully (fresh/req ≈ 326 on T3); kiso's
system prompt is larger (~2.4K) and — the anomaly — its fresh/req ≈ 1.7K
stays at the system-prompt size even within one run: the prefix is not
being cache-hit across requests. That last point is a suspected kiso
defect, not a measurement artifact:

> **待办 (investigation, its own round): kiso's system-prompt prefix is
> not cache-hit across requests.** Symptom: per-request fresh ≈ the system
> prompt size in every scenario (T3: 9,534 fresh / 5.5 reqs ≈ 1.7K ≈ the
> prompt). Hypothesis: a byte-instability in the composed system prompt
> (the D 区 contract — byte-stable for the session's lifetime — would be
> violated if any source varies per request: the mode append, the skills
> index, an injected path/version). If confirmed, it is a real D 区
> contract bug; the fix belongs to a dedicated round, and this bench's
> cost-weighted column will need a re-run to re-baseline.

## The new scenarios (what they measure)

**T4 (skills, progressive loading)**: the fixture gains a repo convention
documented ONLY in a SKILL.md (every src/ feature bumps the PATCH digit of
package.json — enforced by a bench-side check the tests do not reveal).
Each tool surfaced the skill through its NATIVE mechanism: kiso's skills
extension (index + read_skill), pi's `--skill` (index + read tool), Claude
Code's project skills (`.claude/skills/`). All three completed with the
convention applied (0.3.1 → 0.3.2 in every run). The progressive loading
itself is cheap in all three; kiso and pi land within 2% of each other on
raw totals (51.5K vs 52.6K), claude is 6.2× heavier; cost-weighted pi is
4.1× cheaper than kiso.

**T5 (long session, /compact)**: 8 progressive turns on the fixture, then
a final verification. Each tool drove the session with its NATIVE
mechanism: kiso — three processes over one durable session with a
`/compact` (the model summary, ADR-0044) between turns 5 and 6; pi —
eight `-p` invocations sharing one `--session`; claude — eight `-p`
invocations sharing one `--resume` session (its auto-compact never fired
at these context sizes). Every run verified pass. The /compact's own
summary request is inside kiso's total.

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

Then the headline read "2.6× fewer than pi, 21× fewer than CC". The gap
narrowed (now 1.3× / 12.8× on T3): kiso's product grew (the modes round,
the skills index, /compact help, a longer system prompt — kiso's T3 total
nearly doubled 9.5K → 18.2K), while pi and CC barely moved. The 0.1.7
bench also predated the modes round — the current runner needs
`--mode bypass` for kiso, which the old runs did not. The 0.1.7 T2/T3
verify cells were not machine-verified (a verify-script subshell bug made
the pass case report "n/a"); the current runner verifies every cell. The
0.1.7 numbers have no cost-weighted column (the raw transcript data was
not preserved).

## Read this honestly

- These tasks are SMALL. Claude Code's large system prompt buys real product
  capability (task tracking, richer exploration) that pays off on complex
  work these tasks do not exercise. Its 14.5 requests on T3 are it being
  thorough, not broken.
- Claude Code ran off-label (DeepSeek endpoint); its prompts are tuned for
  Claude models.
- n=2, one fixture per scenario, one model. Token accounting is normalized
  per provider convention (fresh = non-cached input, cached = the
  cache-hit prefix; the columns are each provider's own numbers).
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
python3 extract.py .          # T1-T4 (outputs include cost_weighted)
python3 extract-t5.py .       # T5 (outputs include cost_weighted)
```

Requires: the three CLIs installed, a DeepSeek API key in
`~/.config/claude-deepseek/credentials.env` (DEEPSEEK_API_KEY).
Raw data: `runs/<tool>-<task>-<run>/` — each run's transcript, session
log (kiso), per-process logs (pi/claude), wall seconds, and verify verdict.
