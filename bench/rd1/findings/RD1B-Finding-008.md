# RD1B-Finding-008 — a fresh working directory per cell penalises
# cwd-dependent prompt prefixes

- **id:** RD1B-F8
- **class:** benchmark contamination / structural
- **severity:** P1 for the benchmark — it accounts for **98%** of the
  cost difference that survived the RD1B-F7 environment fix
- **scope:** RD-1B, the clean replay, and any batch that runs each cell
  in its own directory
- **status:** OPEN. Measured, not yet corrected. No product code
  changed; no verdict moved.

## What was measured

First request of each cell in the CLEAN replay, in execution order:

| cell | kiso fresh / cached | hit | pi fresh / cached | hit |
|---|---|---:|---|---:|
| c1-r1 | 66 / 2,304 | 97.2% | 71 / 1,664 | 95.9% |
| c2-r1 | 58 / 2,304 | 97.5% | **1,087 / 640** | **37.1%** |
| c3-r1 | 58 / 2,304 | 97.5% | **1,087 / 640** | **37.1%** |
| … every later cell | 58–81 / 2,304 | ~97% | **~1,090 / 640** | **~37%** |

kiso's cacheable prefix is **2,304 tokens on every cell**, byte-stable
across the whole batch — `systemPromptHash` is a single value across
c1-r1, c5-r1 and c10-r2. pi's collapses to 640 from the second cell on.

## The cause, tested directly

pi, isolated profile, no user resources, three runs:

| run | cwd | hit |
|---|---|---:|
| 1 | A (warm-up) | 38.8% |
| 2 | **A — the same directory** | **93.1%** |
| 3 | B — a different directory | 38.8% |

**pi's cacheable prefix depends on the working directory.** kiso's
`composeSystemPrompt(cwd)` takes the cwd but does not put it in the
cached region — the hash is identical across cells whose directories
differ.

The benchmark gives every cell its own fresh directory. So pi's prefix
cache is invalidated 20 times and kiso's is invalidated once.

## What it accounts for

Over the 16 paired cells of the clean replay:

| | |
|---|---:|
| cost-weighted gap, pi − kiso | 15,746 |
| pi's excess FRESH tokens on first requests | 15,440 |
| **share of the gap explained** | **98%** |
| paired ratio if pi's first request cached like kiso's | **1.01×** |
| paired ratio as measured | 1.33× |

**Neutralise this one effect and the two agents cost the same.**

And from the third request onward pi caches BETTER than kiso — 97.5%
against kiso's 90–96% inside the same cell. The disadvantage is
entirely at session start.

## Why this is a benchmark property, not a product one

A real user runs many turns in ONE project directory. That is run 2 in
the table above: **93.1%**. The benchmark's shape — twenty short
sessions, each in a directory nothing has seen before — is close to the
worst case for any agent that keys its prefix on location, and close to
the best case for one that does not.

Which of those two designs is better is a real question, and this
benchmark does not answer it. A cwd in the prefix buys the model
location context on turn one; keeping it out buys cross-project cache
reuse. RD-1B measured the second as a cost advantage without noticing it
had constructed the conditions that produce it.

## What this retracts, again

The clean replay reported pi at 1.33× cost-weighted and a 1.51× paired
median (kiso-doc/kiso-rd1b-clean-replay-report.md). **Those numbers are
not a product comparison either.** They are 98% an artifact of running
each cell somewhere new.

Combined with RD1B-F7, the token line of this whole benchmark has now
been retracted twice: once for what the arms were given, once for how
the cells were laid out. Nothing about token cost from RD-1B or its
clean replay should be published.

## The fix for RD-1C

Two arms of the question, and the spec should state which it is
measuring instead of getting one by accident:

1. **Cold-start cost** — every cell in a fresh directory, as now. Then
   the first-request cache miss is a DECLARED parameter, reported per
   arm, and nobody reads the aggregate as an efficiency result.
2. **Steady-state cost** — a warm-up turn in the same directory before
   the measured turns, so both agents are measured with a warm prefix.
   This is closer to how the tools are actually used.

Reporting both is cheap and is the only way the number means anything.
Whichever is chosen, **first-request cache hit must be reported per arm
alongside the totals** — it was in the artifacts the whole time and
nobody looked.
