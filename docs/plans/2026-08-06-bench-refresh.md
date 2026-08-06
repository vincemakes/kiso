# Bench 刷新轮 — 数字保鲜 + T4 skills + T5 长会话 /compact (no release)

2026-08-06. Spec: "bench 刷新轮(数字保鲜+两个新场景),不发版(bench 不进
npm)。诚实条款照旧(任务小/off-label/n=2);运行脚本与提取器扩展进 bench/;
汇报附原始数据路径。"

## 1. T1-T3 重跑 (kiso 0.1.22 · pi 0.73.1 · Claude Code 2.1.223, n=2)

Same fixture (fixture-v1), same tasks, mean of 2 runs per cell, all 18
cells verified. Numbers in `bench/README.md` + the main README's
comparison table; the 0.1.7-era numbers moved to the bench README's
history section (honest trajectory — the old headline 2.6×/21× became
1.3×/12.8× on T3: kiso's product grew — modes, skills index, /compact,
a longer system prompt — its T3 total nearly doubled while pi/CC barely
moved).

Runner changes found along the way (all in bench/):
- **kiso needs `--mode bypass`** since the modes round: the default tier
  ASKS for write/edit/shell, and the non-TTY bench auto-denies ("no human
  to ask") — the bench-allow extension cannot override the tier's ask
  (deny>ask>allow). The 0.1.7-era runs predated the modes round.
- **A verify-script subshell bug in the original run-one.sh**: `( ... &&
  VERIFY=pass )` assigned inside a SUBSHELL — the parent never saw it, so
  the pass case always reported "n/a". The 0.1.7 T2/T3 cells were never
  machine-verified. Fixed with brace groups; every cell verified now.
- claude's `-p` may print a stdin warning line before the JSON — the
  extractor parses from the first "{" now; the runner passes `< /dev/null`.

## 2. T4 — skills 场景 (progressive loading)

- fixture-v2 adds `src/dates.js` + `tests/days-between.test.js`; the
  convention (a src/ feature bumps the PATCH digit of package.json,
  0.3.1 → 0.3.2) lives ONLY in `bench/t4-skill/repo-conventions/SKILL.md`
  (frontmatter name/description + body — the Agents Skills spec shape).
  The version check is bench-side (`t4-verify.sh`) — the repo's tests do
  NOT reveal the convention.
- Each tool surfaced the skill via its NATIVE channel: kiso's skills
  extension (KISO_SKILLS_DIR index + read_skill), pi's `--skill` flag
  (index + read tool — pi is progressive, same spec), Claude Code's
  project skills (`.claude/skills/` in the repo copy).
- Result (all six runs pass, 0.3.2 everywhere): kiso 51,486 · pi 52,580 ·
  claude 317,781 mean total tokens. The progressive-loading mechanism is
  cheap in all three (index in the prompt, content on demand) — kiso and
  pi within 2% of each other; claude 6.2× heavier (system prompt + 14
  requests of exploration).
- Notes: on the FIRST (fixture-bug) batch the models even fixed my broken
  `import { assert }` fixture — the fixed fixture was re-run. kiso's
  first batch (49-57s) had the model explore the environment instead of
  read_skill; with the clean fixture it used the skill path (21-23s).

## 3. T5 — 长会话 /compact 场景

- fixture-t5: 8 progressive turns (clamp fix + isBetween + maxOf +
  formatRange + parseRangeList + summarize + cli --count + final verify),
  tests pre-seeded (the final API), verified by `t5-verify.sh`.
- Each tool's native session mechanism: kiso — three processes over ONE
  durable session, a `/compact` line (ADR-0044 model summary) between
  turns 5 and 6; pi — eight `-p` invocations sharing one `--session`;
  claude — eight `-p` invocations sharing one `--resume` (its auto-compact
  never fired at these context sizes — methodology noted).
- Result (all six runs pass): kiso 213,398 · pi 263,717 · claude 950,845
  mean total tokens — kiso 1.2× fewer than pi, 4.5× fewer than claude.
  The /compact's own summary request is inside kiso's total.
- Runner notes: run-t5.sh's kiso branch initially MISSED `--mode bypass`
  (writes denied — fixed); the cli --count verify was over-strict (the
  count may be the last line, not the whole output — relaxed to tail -1
  and pi-T5-2's repo verified pass from disk).

## 4. 诚实条款 & raw data

- Same clauses as before: small tasks, CC off-label (DeepSeek endpoint),
  n=2, one fixture per scenario, one model; token accounting per provider
  convention; kiso is our own tool — reproduce via bench/run-one.sh +
  bench/run-t5.sh + extract.py/extract-t5.py.
- T3's verify checks the code still works (the fixture's user.test.js
  passes pre-rename) — the transcripts show the renames happened.
- **Raw data paths**: `bench/runs/<tool>-<task>-<run>/` — 30 runs
  (T1-T4: stdout transcript + kiso session log + wall + verify; T5:
  per-process logs + the durable session). The dir is gitignored (87M) —
  kept on disk, reproducible via the scripts.
- No release: bench does not go to npm (the spec).
