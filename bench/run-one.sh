#!/bin/sh
# run-one.sh <tool: kiso|pi|claude> <task: T1|T2|T3> <run-id>
# Copies the fixture fresh, runs the tool headless on the task, records
# wall time + exit code + the tool's own transcript for usage extraction.
set -eu
TOOL=$1; TASK=$2; RUN=$3
B="$(cd "$(dirname "$0")" && pwd)"
# KISO_BIN overrides the kiso command (band A/B runs against a pinned
# published bin: KISO_BIN="npx -y @vincemakes/kiso-code@0.2.1"). KISO_VERSION
# names that bin in meta.json (default: the local checkout's version).
KISO_BIN=${KISO_BIN:-kiso}
KISO_VERSION=${KISO_VERSION:-$(node -p "require('$B/../apps/cli/package.json').version")}
# E4-e: KISO_ROUND scopes the runs under runs/<round>/ (the run-hygiene
# discipline — a round never reuses a historical run name); absent = the
# historical flat layout.
WORK="$B/runs/${KISO_ROUND:+$KISO_ROUND/}$TOOL-$TASK-$RUN"
rm -rf "$WORK"; mkdir -p "$WORK"
cp -R "$B/fixture-v1/" "$WORK/repo/"
rm -rf "$WORK/repo/.git"
PROMPT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$B/tasks.json','utf8'))['$TASK'])")
if [ "$TASK" = "T4" ]; then
  cp -R "$B/fixture-v2/" "$WORK/repo/"
  rm -rf "$WORK/repo/.git"
  # the same SKILL.md, each tool via its NATIVE channel: kiso's skills dir,
  # pi's --skill flag, Claude Code's project skills dir.
  mkdir -p "$WORK/repo/.claude/skills/repo-conventions"
  cp "$B/t4-skill/repo-conventions/SKILL.md" "$WORK/repo/.claude/skills/repo-conventions/SKILL.md"
fi
. "${XDG_CONFIG_HOME:-$HOME/.config}/claude-deepseek/credentials.env"

START=$(date +%s)
cd "$WORK/repo"
case "$TOOL" in
  kiso)
    EXTDIR="$WORK/ext"; mkdir -p "$EXTDIR"; cp "$B/bench-allow.mjs" "$EXTDIR/"
    SKILLS_ENV=""
    # T4 (the 0.1.27 the disqualification investigation): the scenario spec says the skill surfaces
    # through kiso's NATIVE mechanism (the skills extension's index +
    # read_skill) — the ext dir previously carried only bench-allow, so the
    # model had to discover .claude/skills by raw exploration (the 13-request
    # vs pi 8.5 gap, and a run that never found the skill at all). The
    # official skills extension rides KISO_SKILLS_DIR; load it for T4.
    [ "$TASK" = "T4" ] && { SKILLS_ENV="KISO_SKILLS_DIR=$B/t4-skill"; cp "$B/../extensions/skills/src/kiso-skills.mjs" "$EXTDIR/"; }
    printf '%s\nexit\n' "$PROMPT" | env \
      OPENAI_BASE_URL="https://api.deepseek.com" \
      OPENAI_API_KEY="$DEEPSEEK_API_KEY" \
      OPENAI_MODEL="deepseek-v4-flash" \
      KISO_EXTENSIONS_DIR="$EXTDIR" \
      KISO_HOME="$WORK/kiso-home" \
      $SKILLS_ENV \
      $KISO_BIN --mode bypass "bench-$TOOL-$TASK-$RUN" > "$WORK/stdout.log" 2>&1 || true
    node -e "
const fs = require('fs');
const { execSync } = require('child_process');
const meta = {
  tool: 'kiso', task: '$TASK', run: '$RUN', round: process.env.KISO_ROUND || null,
  model: 'deepseek-v4-flash',
  kisoVersion: '$KISO_VERSION',
  commit: execSync('git -C $B/.. rev-parse --short HEAD').toString().trim(),
  createdAt: Date.now(),
};
fs.writeFileSync('$WORK/meta.json', JSON.stringify(meta, null, 1) + '\n');
"
    ;;
  pi)
    SKILL_FLAG=""
    [ "$TASK" = "T4" ] && SKILL_FLAG="--skill $B/t4-skill/repo-conventions"
    env DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
      pi --provider deepseek --model deepseek-v4-flash -p --mode json \
      $SKILL_FLAG "$PROMPT" > "$WORK/stdout.log" 2>&1 || true
    ;;
  claude)
    env ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic" \
      ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" \
      ANTHROPIC_MODEL="deepseek-v4-flash" \
      ANTHROPIC_DEFAULT_SONNET_MODEL="deepseek-v4-flash" \
      ANTHROPIC_DEFAULT_HAIKU_MODEL="deepseek-v4-flash" \
      claude -p "$PROMPT" --output-format json --dangerously-skip-permissions < /dev/null \
      > "$WORK/stdout.log" 2>&1 || true
    ;;
esac
END=$(date +%s)
echo "$((END-START))" > "$WORK/wall_seconds"

# verification per task
VERIFY="n/a"
case "$TASK" in
  T2) { node tests/clamp.test.js >/dev/null 2>&1 && VERIFY=pass; } || VERIFY=fail ;;
  T3) { node tests/user.test.js >/dev/null 2>&1 && node src/cli.js >/dev/null 2>&1 && VERIFY=pass; } || VERIFY=fail ;;
  T4) VERIFY=$("$B/t4-verify.sh" "$WORK/repo") ;;
esac
echo "$VERIFY" > "$WORK/verify"
echo "DONE $TOOL $TASK run=$RUN wall=$(cat "$WORK/wall_seconds")s verify=$VERIFY"
