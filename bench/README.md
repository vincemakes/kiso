# kiso-bench — same model, same tasks, three coding agents

Date: 2026-08-04 · model: **deepseek-v4-flash** for all three tools ·
kiso 0.1.7 · pi (@mariozechner/pi-coding-agent latest) · Claude Code 2.1.221
(via DeepSeek's Anthropic-compatible endpoint). Mean of 2 runs per cell;
every run's task verification passed for every tool — capability was equal
on these tasks, so the columns below measure efficiency alone.

| task | tool | fresh in | cached in | total in | out | reqs | wall |
|------|--------|-------:|-------:|-------:|-----:|----:|-----:|
| T1 read+answer | **kiso** | **839** | 1,536 | **2,375** | 126 | 2 | **4.0s** |
| | pi | 2,885 | 6,016 | 8,901 | 156 | 2 | 4.0s |
| | claude | 28,407 | 22,464 | 50,871 | 227 | 2 | 9.5s |
| T2 fix+verify | **kiso** | **672** | 4,864 | **5,536** | 275 | 4 | **6.5s** |
| | pi | 3,876 | 14,784 | 18,660 | 325 | 4 | 7.5s |
| | claude | 29,435 | 73,856 | 103,291 | 708 | 4.5 | 13.5s |
| T3 cross-file rename | **kiso** | **1,854** | 7,680 | **9,534** | 788 | 5 | **9.5s** |
| | pi | 3,673 | 20,992 | 24,665 | 836 | 5 | 11.0s |
| | claude | 32,109 | 170,880 | 202,989 | 2,278 | 15.5 | 30.5s |

Headline (T3, the hardest task): kiso processed **2.6× fewer** total input
tokens than pi and **21× fewer** than Claude Code, at 3× Claude Code's speed
— with identical task outcomes.

## Read this honestly

- These tasks are SMALL. Claude Code's large system prompt buys real product
  capability (task tracking, richer exploration) that pays off on complex
  work these tasks do not exercise. Its 15.5 requests on T3 are it being
  thorough, not broken.
- Claude Code ran off-label (DeepSeek endpoint); its prompts are tuned for
  Claude models.
- n=2, one fixture, one model. Token accounting is normalized per provider
  convention (OpenAI-format `prompt_tokens` includes cache; Anthropic-format
  is disjoint) — see extract.py.
- kiso is our own tool. Reproduce it yourself: everything needed is in this
  directory.

## Reproduce

```
./run-one.sh <kiso|pi|claude> <T1|T2|T3> <run-id>
python3 extract.py .
```

Requires: the three CLIs installed, a DeepSeek API key in
`~/.config/claude-deepseek/credentials.env` (DEEPSEEK_API_KEY).
