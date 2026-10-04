#!/bin/sh
# run-task.sh <task: T3|L1|L2|F1> <run-id> — one kiso leg of the 0.46.0
# evaluation (kiso-doc plan-0460-3f-evaluation; ADR-0058 §11).
#
# One prompt, one session, run on the leg-isolation, bare-home, deadline
# and cred-exec machinery run-t5.sh established (see its notes; they are
# not repeated here). Two things are new:
#
#   - the ROUTE (route.sh): BENCH_ROUTE=ds|co, shared by both arms;
#   - the STDIN: feed-until-idle.mjs keeps it open until the session is
#     idle — a run ended, no task live, the log quiet — because a stdin that
#     ends at once makes the CLI exit and a clean exit stops every task:
#     the harness, not the product, would end the work.
#
# Writes, under the leg's directory: meta.json, wall_seconds, exit, status
# (complete | incomplete:<why>), verify (pass | fail), counters.json.
set -eu
TASK=$1; RUN=$2
B="$(cd "$(dirname "$0")" && pwd)"
KISO_BIN=${KISO_BIN:-kiso}
case "$TASK" in
	T3) FIXTURE=fixture-v1; PROMPT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$B/tasks.json','utf8')).T3)") ;;
	L1|L2|F1) FIXTURE=fixture-$(printf '%s' "$TASK" | tr 'LF' 'lf'); PROMPT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$B/tasks-0460.json','utf8'))['$TASK'])") ;;
	*) echo "run-task.sh: unknown task $TASK (T3 | L1 | L2 | F1)" >&2; exit 1 ;;
esac

# The version the arm WILL run, asked of the binary itself (run-t5.sh's
# rule: an arm labelled with a version it never executed is worse than no
# run), bounded and in its own process group.
if [ -z "${KISO_VERSION:-}" ]; then
	_probe_out=$(mktemp)
	set +e
	perl -e '
		my $secs = shift;
		my $pid = fork();
		if (!defined $pid) { exit 127; }
		if ($pid == 0) { setpgrp(0, 0); exec @ARGV or exit 127; }
		$SIG{ALRM} = sub { kill("KILL", -$pid); waitpid($pid, 0); exit 142; };
		alarm $secs;
		waitpid($pid, 0);
		my $sig = $? & 127;
		exit($sig ? 128 + $sig : ($? >> 8));
	' "${KISO_PROBE_DEADLINE_S:-20}" $KISO_BIN --version >"$_probe_out" 2>/dev/null </dev/null
	_rc=$?
	set -e
	KISO_VERSION=$(tr -d '\r' < "$_probe_out" | tail -1)
	rm -f "$_probe_out"
	[ "$_rc" -eq 0 ] || KISO_VERSION=""
fi
case "$KISO_VERSION" in
	[0-9]*.[0-9]*.[0-9]*) : ;;
	*) echo "FAIL: KISO_BIN ($KISO_BIN) did not report a version." >&2; exit 1 ;;
esac

. "$B/leg-isolation.sh"
WORK="$(runs_root "$B")/${KISO_ROUND:+$KISO_ROUND/}kiso-$TASK-$RUN"
rm -rf "$WORK"; mkdir -p "$WORK"
cp -R "$B/$FIXTURE/" "$WORK/repo/"
rm -rf "$WORK/repo/.git"
# L2: the leg's own port, so legs never collide — part of the baseline
if [ "$TASK" = L2 ]; then
	node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})' > "$WORK/repo/.port"
fi
git -C "$WORK/repo" init -q
git -C "$WORK/repo" config user.email bench@localhost
git -C "$WORK/repo" config user.name bench
git -C "$WORK/repo" add -A
git -C "$WORK/repo" -c commit.gpgsign=false commit -q -m "fixture baseline" || true
if ! assert_leg_isolated "$WORK" "$WORK/repo"; then
	cat "$WORK/void" >&2
	exit 3
fi

. "$B/route.sh"
. "$B/leg-limits.sh"
. "$B/bare-env.sh"
BARE_HOME=$(bare_home "$WORK")
LEG_DEADLINE_S=${KISO_LEG_DEADLINE_S:-1800}
BENCH_EFFORT=${BENCH_EFFORT:-high}
EFFORT_LINE="/model ds $BENCH_EFFORT"
[ "$BENCH_EFFORT" = none ] && EFFORT_LINE=""

EXTDIR="$WORK/ext"; mkdir -p "$EXTDIR"; cp "$B/bench-allow.mjs" "$EXTDIR/"
SKILLDIR="$WORK/skills"; mkdir -p "$SKILLDIR"
mkdir -p "$WORK/kiso-home/sessions"
route_profile_json > "$WORK/kiso-home/config.json"
assert_bare kiso "$BARE_HOME" || exit 1
SID="bench-$TASK-$RUN"

cd "$WORK/repo"
S=$(date +%s)
set +e
# shellcheck disable=SC2086
node "$B/feed-until-idle.mjs" "$WORK/kiso-home/sessions" "$SID" "$LEG_DEADLINE_S" -- ${EFFORT_LINE:+"$EFFORT_LINE"} "$PROMPT" |
	bare_bounded "$BARE_HOME" "$LEG_DEADLINE_S" "$WORK/stdout.log" \
		"OPENAI_BASE_URL=$ROUTE_BASE_URL" "BENCH_CRED_FILE=$ROUTE_CRED_FILE" "BENCH_CRED_AS=OPENAI_API_KEY" "BENCH_CRED_KEY=$ROUTE_CRED_KEY" \
		"OPENAI_MODEL=$ROUTE_MODEL" "KISO_EXTENSIONS_DIR=$EXTDIR" "KISO_HOME=$WORK/kiso-home" \
		"KISO_SESSIONS_DIR=$WORK/kiso-home/sessions" "KISO_SKILLS_DIR=$SKILLDIR" "KISO_NO_UPDATE_CHECK=1" \
		-- sh "$B/cred-exec.sh" $KISO_BIN --mode bypass "$SID"
RC=$?
set -e
E=$(date +%s)
echo "$((E - S))" > "$WORK/wall_seconds"
echo "$RC" > "$WORK/exit"

node -e "
const fs = require('fs');
fs.writeFileSync('$WORK/meta.json', JSON.stringify({
  tool: 'kiso', task: '$TASK', run: '$RUN', round: process.env.KISO_ROUND || null,
  model: '$ROUTE_MODEL', route: '$BENCH_ROUTE', effort: '$BENCH_EFFORT',
  kisoVersion: '$KISO_VERSION', createdAt: Date.now(),
}, null, 1) + '\n');
"
EFFORT_BOUND=$(node -e '
const fs=require("fs"),p=require("path");
const d=process.argv[1]+"/kiso-home/sessions";
let bound=null;
try{
  const meta=fs.readdirSync(d).filter(x=>x.endsWith(".meta.json") && !x.startsWith("sub-"))[0];
  const j=JSON.parse(fs.readFileSync(p.join(d,meta),"utf8"));
  bound=(j.profile && j.profile.reasoning && j.profile.reasoning.effort) || null;
}catch{}
process.stdout.write(bound === null ? "" : String(bound));
' "$WORK" 2>/dev/null || echo "")
if [ "$RC" -eq 142 ]; then
	mark_incomplete "$WORK" deadline "the leg's ${LEG_DEADLINE_S}s wall budget was spent"
elif [ "$RC" -ne 0 ]; then
	mark_incomplete "$WORK" launch_or_run_error "the arm exited $RC"
elif [ "$BENCH_EFFORT" != none ] && [ "$EFFORT_BOUND" != "$BENCH_EFFORT" ]; then
	mark_incomplete "$WORK" effort_not_bound "wanted $BENCH_EFFORT, the durable profile says ${EFFORT_BOUND:-<none>}"
else
	mark_complete "$WORK"
fi

case "$TASK" in
	T3) VERIFY=fail; (cd "$WORK/repo" && node tests/user.test.js >/dev/null 2>&1 && node src/cli.js >/dev/null 2>&1) && VERIFY=pass ;;
	L1) VERIFY=$(sh "$B/l1-verify.sh" "$WORK/repo") ;;
	L2) VERIFY=$(sh "$B/l2-verify.sh" "$WORK/repo" "$WORK" 2>/dev/null) ;;
	F1) VERIFY=$(node "$B/f1-verify.mjs" "$WORK") ;;
esac
echo "$VERIFY" > "$WORK/verify"
node "$B/tasks-counters.mjs" "$WORK" > "$WORK/counters.json" 2>/dev/null || echo '{"error":"the counters did not run"}' > "$WORK/counters.json"
echo "DONE $TASK run=$RUN wall=$(cat "$WORK/wall_seconds")s verify=$VERIFY status=$(cat "$WORK/status")"
