# kiso-bench — same model, same tasks, three coding agents

Date: 2026-08-06 · model: **deepseek-v4-flash** for all three tools ·
kiso 0.1.22 · pi (@mariozechner/pi-coding-agent 0.73.1) · Claude Code
2.1.223 (via DeepSeek's Anthropic-compatible endpoint). Mean of 2 runs per
cell; every run's task verification passed for every tool — capability was
equal on these tasks, so the columns below measure efficiency alone.
kiso ran with `--mode bypass` (the bench-allow extension + the bypass tier
— the default tier's ask flow cannot run headless).

| task | tool | fresh in | cached in | total in | out | reqs | wall |
|------|--------|-------:|-------:|-------:|-----:|----:|-----:|
| T1 read+answer | **kiso** | 2,372 | 2,176 | **4,548** | 134 | 2.0 | **4.5s** |
| | pi | 1,146 | 7,680 | 8,826 | 158 | 2.0 | 5.5s |
| | claude | 25,926 | 25,792 | 51,718 | 226 | 2.0 | 6.0s |
| T2 fix+verify | **kiso** | 5,490 | 5,184 | **10,674** | 327 | 4.0 | **7.5s** |
| | pi | 1,493 | 17,152 | 18,645 | 396 | 4.0 | 10.5s |
| | claude | 26,520 | 78,208 | 104,728 | 646 | 4.5 | 13.5s |
| T3 cross-file rename | **kiso** | 9,534 | 8,640 | **18,174** | 719 | 5.5 | **11.5s** |
| | pi | 1,628 | 22,784 | 24,412 | 752 | 5.0 | 13.0s |
| | claude | 28,196 | 203,648 | 231,844 | 2,094 | 14.5 | 30.0s |
| T4 skills (repo convention) | **kiso** | 26,910 | 24,576 | **51,486** | 1,394 | 10.5 | **22.0s** |
| | pi | 2,212 | 50,368 | 52,580 | 2,536 | 8.5 | 34.0s |
| | claude | 30,293 | 287,488 | 317,781 | 4,234 | 14.0 | 54.0s |
| T5 8-turn session + /compact | **kiso** | 110,678 | 102,720 | **213,398** | 4,549 | 33.5 | **81.5s** |
| | pi | 4,517 | 259,200 | 263,717 | 7,148 | 32.5 | 95.5s |
| | claude | 32,189 | 918,656 | 950,845 | 10,333 | 32.0 | 141.0s |

Headline (T3, the hardest single task): kiso processed **1.3× fewer**
total input tokens than pi and **12.8× fewer** than Claude Code — with
identical task outcomes. On the T5 long session (with kiso's mid-way
/compact), kiso used **1.2× fewer** than pi and **4.5× fewer** than CC.

## The new scenarios

**T4 (skills, progressive loading)**: the fixture gains a repo convention
documented ONLY in a SKILL.md (every src/ feature bumps the PATCH digit of
package.json — enforced by a bench-side check the tests do not reveal).
Each tool surfaced the skill through its NATIVE mechanism: kiso's skills
extension (index + read_skill), pi's `--skill` (index + read tool), Claude
Code's project skills (`.claude/skills/`). All three completed with the
convention applied (0.3.1 → 0.3.2 in every run). The progressive loading
itself is cheap in all three (index in the prompt, content read on
demand); the measured spread comes from the models' behavior — kiso and
pi land within 2% of each other (51.5K vs 52.6K total), claude is 6.2×
heavier (its system prompt + 14 requests of exploration).

**T5 (long session, /compact)**: 8 progressive turns on the fixture, then
a final verification. Each tool drove the session with its NATIVE
mechanism: kiso — three processes over one durable session with a
`/compact` (the model summary, ADR-0044) between turns 5 and 6; pi —
eight `-p` invocations sharing one `--session`; claude — eight `-p`
invocations sharing one `--resume` session (its auto-compact never fired
at these context sizes). Every run verified pass. kiso: 213.4K total
(1.2× fewer than pi, 4.5× fewer than claude); the /compact's own summary
request is inside kiso's total.

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
the pass case report "n/a"); the current runner verifies every cell.

## Read this honestly

- These tasks are SMALL. Claude Code's large system prompt buys real product
  capability (task tracking, richer exploration) that pays off on complex
  work these tasks do not exercise. Its 14.5 requests on T3 are it being
  thorough, not broken.
- Claude Code ran off-label (DeepSeek endpoint); its prompts are tuned for
  Claude models.
- n=2, one fixture per scenario, one model. Token accounting is normalized
  per provider convention (OpenAI-format `prompt_tokens` includes cache;
  Anthropic-format is disjoint) — see extract.py / extract-t5.py.
- T3's verify checks the code still works (the fixture's user.test.js
  passes pre-rename too) — the rename itself is NOT machine-checked; the
  transcripts show the renames happened in every run.
- kiso is our own tool. Reproduce it yourself: everything needed is in
  this directory.

## Reproduce

```
./run-one.sh <kiso|pi|claude> <T1|T2|T3|T4> <run-id>
./run-t5.sh <kiso|pi|claude> <run-id>
python3 extract.py .          # T1-T4
python3 extract-t5.py .       # T5
```

Requires: the three CLIs installed, a DeepSeek API key in
`~/.config/claude-deepseek/credentials.env` (DEEPSEEK_API_KEY).
Raw data: `runs/<tool>-<task>-<run>/` — each run's transcript, session
log (kiso), per-process logs (pi/claude), wall seconds, and verify verdict.
