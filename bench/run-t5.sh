#!/bin/sh
# run-t5.sh <tool: kiso|pi|claude> <run-id>
# The long-session scenario: 8 progressive turns on fixture-t5, then the
# final verify. Each tool drives the session with its NATIVE mechanism:
#   kiso   — 3 processes on one durable session: turns 1-5, then the
#            /compact line (the round's subject — the mid-way model
#            summary), then turns 6-8. The session log is the durable
#            thread; EOF ends each process.
#   pi     — 8 `-p` invocations sharing one --session file (its native
#            session continuation).
#   claude — 8 `-p` invocations sharing one --resume session (its native;
#            CC auto-compacts on its own threshold if it ever fires).
# Wall = the sum of the per-process seconds. Usage is extracted per tool
# from its own records by extract-t5.py.
set -eu
TOOL=$1; RUN=$2
B="$(cd "$(dirname "$0")" && pwd)"
# KISO_BIN overrides the kiso command (band A/B runs against a pinned
# published bin: KISO_BIN="npx -y @vincemakes/kiso-code@0.2.1"). KISO_VERSION
# names that bin in meta.json.
#
# THE DEFAULT ASKS THE BINARY THAT WILL RUN, NOT THE CHECKOUT AROUND IT.
# It used to read the local apps/cli/package.json unconditionally, so handing
# this script a pinned published bin recorded the HOST's version in
# meta.json — an arm labelled with a version it never executed, which is the
# one field a comparison between arms cannot afford to have wrong. The
# historical caveat on runs recorded before this change stands; the records
# are not rewritten.
KISO_BIN=${KISO_BIN:-kiso}
# Only the kiso arm needs a kiso version, and only when one was not given.
# Probing unconditionally made every OTHER agent's run require kiso to be
# installed — a bench runner that cannot measure a competitor without our
# own binary present is a broken runner (Astra, PR #32).
if [ "$TOOL" = "kiso" ] && [ -z "${KISO_VERSION:-}" ]; then
  # `$KISO_BIN --version` unquoted on purpose: KISO_BIN may be a COMMAND with
  # arguments ("npx -y @vincemakes/kiso-code@0.2.1"), not a single path.
  # The EXIT STATUS is kept: a bin that fails while printing to stdout used to
  # have its error message recorded as the version — "error: unknown flag
  # --version" went into meta.json as if it were 0.34.0.
  # THE PROBE IS A PROCESS LIKE ANY OTHER, AND NOTHING WAS WATCHING IT.
  #
  # The per-leg limits live in bare-env.sh, sourced further below, and they
  # bound the leg's WORK. This runs before any of that exists: a bin that
  # hangs here stalls the leg BEFORE its clock starts, and no deadline, no
  # budget and no classifier ever sees it.
  #
  # RUNNER-R1 (Astra): the first repair bounded the wrong thing, twice.
  #
  # `perl alarm` kills the process it exec'd and NOT its descendants, and
  # KISO_BIN is documented to be a wrapper ("npx -y ..."). A wrapper whose
  # child outlives it keeps the command substitution's stdout pipe open, so
  # the substitution waits for EOF long after the alarm fired: measured at
  # 10s against a 1s deadline. So the probe runs in its OWN PROCESS GROUP,
  # the alarm kills the GROUP, and the output goes to a FILE — a pipe is a
  # second thing a descendant can hold, and there is no reason to hold one.
  #
  # And `set -e` is on. `PROBE=$(...)` failing exited the runner BEFORE the
  # status check, so the message written to explain a hang could never
  # print: /usr/bin/false exits in 0.011s with empty stderr. The capture is
  # now inside a `set +e` window, which is the only way to read a status
  # the shell would otherwise act on first.
  KISO_PROBE_DEADLINE_S=${KISO_PROBE_DEADLINE_S:-20}
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
    # A SIGNAL DEATH IS NOT A CLEAN EXIT. `$? >> 8` is 0 for a process
    # killed by a signal, so a bin that printed a version and was then
    # SIGTERMed read as success and its output was accepted. The low byte
    # carries the signal; anything there becomes 128 + it, the shell own
    # convention, which never collides with a real exit status.
    #
    # (No apostrophes in here: this whole program is a single-quoted shell
    # string, and the first version of this comment closed it.)
    my $sig = $? & 127;
    exit($sig ? 128 + $sig : ($? >> 8));
  ' "$KISO_PROBE_DEADLINE_S" $KISO_BIN --version >"$_probe_out" 2>/dev/null </dev/null
  PROBE_RC=$?
  set -e
  PROBE=$(cat "$_probe_out" 2>/dev/null || echo "")
  rm -f "$_probe_out"
  if [ "$PROBE_RC" -eq 0 ]; then
    KISO_VERSION=$(printf '%s' "$PROBE" | tr -d '\r' | tail -1)
  else
    KISO_VERSION=""
    if [ "$PROBE_RC" -eq 142 ]; then
      echo "FAIL: KISO_BIN ($KISO_BIN) did not answer --version within ${KISO_PROBE_DEADLINE_S}s." >&2
    else
      echo "FAIL: KISO_BIN ($KISO_BIN) exited $PROBE_RC answering --version." >&2
    fi
  fi
  # And it must LOOK like a version. Anything else is a bin that answered
  # something other than the question.
  case "$KISO_VERSION" in
    [0-9]*.[0-9]*.[0-9]*) : ;;
    *) KISO_VERSION="" ;;
  esac
  if [ -z "$KISO_VERSION" ]; then
    echo "FAIL: KISO_BIN ($KISO_BIN) did not report a version." >&2
    echo "      A run labelled with the WRONG version is worse than no run —" >&2
    echo "      an arm's version is the one field a comparison cannot afford" >&2
    echo "      to have wrong. Set KISO_VERSION explicitly if this bin cannot" >&2
    echo "      report one." >&2
    exit 1
  fi
fi
# E4-e: KISO_ROUND scopes the runs under runs/<round>/ (the run-hygiene
# discipline — a round never reuses a historical run name); absent = the
# historical flat layout.
WORK="$B/runs/${KISO_ROUND:+$KISO_ROUND/}$TOOL-T5-$RUN"
rm -rf "$WORK"; mkdir -p "$WORK"
cp -R "$B/fixture-t5/" "$WORK/repo/"
rm -rf "$WORK/repo/.git"
# ISOLATION: the leg's repo gets its OWN git, and it is not optional.
#
# Deleting .git and stopping there leaves the fixture inside whatever
# repository the runs directory happens to live in, and git WALKS UP. A T6
# leg ran `git stash && ... ; git stash pop` to compare against HEAD; with
# no repository of its own it reached the HOST worktree, found it clean so
# stashed nothing, and popped the operator's PARKED stash instead — which
# conflicted, left a file behind, and sent the agent into recovering a mess
# that had nothing to do with its task. 7,663 of that leg's 7,961 thinking
# tokens came AFTER the conflict, and the leg was read as the expensive one
# for reasons that were ours.
#
# An empty repo with one commit gives `git stash`, `git diff` and `git log`
# somewhere to land that is the leg's own. Identity is set locally so the
# operator's name is not attached to bench commits.
git -C "$WORK/repo" init -q
git -C "$WORK/repo" config user.email bench@localhost
git -C "$WORK/repo" config user.name bench
git -C "$WORK/repo" add -A
git -C "$WORK/repo" -c commit.gpgsign=false commit -q -m "fixture baseline" || true
. "${XDG_CONFIG_HOME:-$HOME/.config}/claude-deepseek/credentials.env"
TOT=0
# PER-LEG HARD LIMITS. A leg had none: a hung arm ran until someone noticed,
# a looping arm spent the programme's budget on one task. Overridable, but
# never absent.
. "$B/leg-limits.sh"
. "$B/bare-env.sh"
BARE_HOME=$(bare_home "$WORK")
LEG_DEADLINE_S=${KISO_LEG_DEADLINE_S:-1800}
LEG_MAX_REQUESTS=${KISO_LEG_MAX_REQUESTS:-200}
LEG_STARTED=$(date +%s)
LEG_STOPPED=""

# Remaining wall budget for the next segment, or empty when it is spent.
remaining() {
	_used=$(( $(date +%s) - LEG_STARTED ))
	_left=$(( LEG_DEADLINE_S - _used ))
	[ "$_left" -gt 0 ] && echo "$_left" || echo ""
}

# Stop between segments when a bound is reached. Marks the leg INCOMPLETE
# with its reason — never `fail`: a product that would have finished in one
# more minute did not fail the task, it hit OUR limit.
over_budget() {
	_left=$(remaining)
	if [ -z "$_left" ]; then
		mark_incomplete "$WORK" deadline "the leg's ${LEG_DEADLINE_S}s wall budget was spent"
		LEG_STOPPED=deadline; return 0
	fi
	# F33-R5: a counter that cannot answer stops the leg rather than waving
	# it through. "unknown requests so far" is not "none so far".
	if ! _reqs=$(requests_so_far "$WORK" "$TOOL"); then
		mark_incomplete "$WORK" counter "the request counter could not read this leg's ledger"
		LEG_STOPPED=counter; return 0
	fi
	if [ "$_reqs" -ge "$LEG_MAX_REQUESTS" ]; then
		mark_incomplete "$WORK" requests "the leg was admitted at $_reqs requests (segment-admission ceiling $LEG_MAX_REQUESTS; not a hard cap during a process)"
		LEG_STOPPED=requests; return 0
	fi
	return 1
}

cd "$WORK/repo"
# THE ROUND'S REASONING LEVEL, pinned for every arm that has the knob.
#
# Amendment 4b: a comparison of products at different reasoning levels
# compares SETTINGS, not products. Left alone the arms disagree — kiso sends
# NOTHING and takes whatever the server defaults to, while the reference
# implementation sends its own `medium`, which this vendor maps to `high`.
# The cost difference between those two is the most expensive variable in
# the whole comparison: thinking was 73% of output in the PR-1c round.
#
# So both sides say it OUT LOUD. Pinning only the comparator would align it
# to a value we BELIEVE ours takes — the server's unstated default, which we
# have never measured and do not control. The same shape as reading a
# fallback as a measurement, which is the defect this whole round began with.
BENCH_EFFORT=${BENCH_EFFORT:-high}
TURN() { node -e "console.log(JSON.parse(require('fs').readFileSync('$B/tasks-t5.json','utf8'))[$1-1])"; }

# F33-R6: declared for EVERY arm, not inside one. It lived in the kiso
# branch while the completion decision at the end is shared by all three, so
# a pi or claude leg reached that line with the variable never set and
# `set -u` killed the runner — after the work was done, leaving no status and
# no verify record. Initialising it alone would only have turned the crash
# into silence: those two arms discard their exit codes as well, so they
# record them now too.
SEG_FAILURE=""

# note_exit <label> <rc> <budget-seconds> — one classifier for three arms.
note_exit() {
	[ "$2" -eq 0 ] && return 0
	if [ "$2" -eq 142 ]; then
		[ -n "$SEG_FAILURE" ] || SEG_FAILURE="deadline:$1 hit the $3s remaining wall budget"
	else
		[ -n "$SEG_FAILURE" ] || SEG_FAILURE="launch_or_run_error:$1 exited $2"
	fi
}

case "$TOOL" in
  kiso)
    EXTDIR="$WORK/ext"; mkdir -p "$EXTDIR"; cp "$B/bench-allow.mjs" "$EXTDIR/"
    SKILLDIR="$WORK/skills"; mkdir -p "$SKILLDIR"
    # A NAMED PROFILE, because `/model` only knows profiles.
    #
    # The arm's binding is otherwise the OPENAI_* environment, which gives
    # kiso a working model and NO profile to name — so the effort line
    # would have been refused on every leg and every one of them marked
    # `effort_not_bound`. The gate would have been right and the round
    # would have been wasted; the pre-flight check is what this replaces.
    #
    # Amendment 4b rule 2 names this mechanism itself ("for kiso that is a
    # mode profile carrying an effort"), and the effort A/B round ran this
    # exact shape. The env pairs stay: the profile carries the endpoint
    # across the switch, which is CTX-1's lesson one field over.
    mkdir -p "$WORK/kiso-home"
    cat > "$WORK/kiso-home/config.json" <<CFG
{ "models": { "ds": { "kind": "openai-compat", "model": "deepseek-flash",
  "baseUrl": "https://api.deepseek.com", "apiKeyEnv": "OPENAI_API_KEY" } } }
CFG
    assert_bare kiso "$BARE_HOME" || exit 1
    # §3: KISO_SKILLS_DIR was missing entirely — an arm reading the operator's
    # skills is not the product as installed.
    # §3: KISO_SKILLS_DIR was missing entirely — an arm reading the
    # operator's skills is not the product as installed.
    set -- "OPENAI_BASE_URL=https://api.deepseek.com" "OPENAI_API_KEY=$DEEPSEEK_API_KEY" \
      "OPENAI_MODEL=deepseek-flash" "KISO_EXTENSIONS_DIR=$EXTDIR" \
      "KISO_HOME=$WORK/kiso-home" "KISO_SKILLS_DIR=$SKILLDIR" "KISO_NO_UPDATE_CHECK=1"
    KISO_ENV_PAIRS="$*"
    # F33-R4: the exit status is KEPT, not discarded. Every segment used to
    # end in `|| true`, and the absence of a limit status later became
    # `complete` — a fake CLI that reported a valid version and exited 7 on
    # every invocation produced three launch-error logs, runner rc=0 and a
    # leg recorded as COMPLETE. The verifier caught that particular fixture,
    # but the execution-validity record was false, and a killed FINAL
    # segment needs no successor to check it.
    #
    # 142 is the deadline (perl's alarm, through the shell). Anything else
    # non-zero is the process failing to run or failing while running; both
    # are OURS or the environment's, never the task's verdict.
    seg() { # seg <n> <stdin-producer...>
      _n=$1; shift
      over_budget && return 0
      _left=$(remaining)
      S=$(date +%s)
      set +e
      # shellcheck disable=SC2086
      "$@" | bare_bounded "$BARE_HOME" "$_left" "$WORK/stdout-$_n.log" \
        $KISO_ENV_PAIRS -- $KISO_BIN --mode bypass "bench-t5-$TOOL-$RUN"
      _rc=$?
      set -e
      E=$(date +%s); TOT=$((TOT + E - S))
      printf '%s\n' "$_rc" > "$WORK/exit-$_n"
      note_exit "segment $_n" "$_rc" "$_left"
    }
    # the effort switch rides the FIRST segment as its opening line, which
    # is how a human sets it: there is no config field and no flag, only the
    # per-session `/model` command.
    # AMENDMENT (2026-09-15): THE MID-WAY /compact IS OFF BY DEFAULT.
    #
    # It was sent to THIS ARM and to no other, and the diagnosis of round B
    # measured what that cost: exactly one cache break per leg, all at turn
    # 6, the cached prefix collapsing to the same 2,304 floor, and that ONE
    # request carrying 30.0% / 49.6% / 40.5% of the leg's entire fresh
    # input. Removing it from the index moves the measured T5 gap from
    # +39.9% to +28.7% median. A step one arm takes and the other does not
    # is not a comparison, whatever else it is.
    #
    # BENCH_T5_COMPACT=1 restores it for a round that WANTS to price
    # compaction — that is a real question, just not this one — and the
    # manifest records which way the leg ran, so no reader has to guess.
    if [ "${BENCH_T5_COMPACT:-0}" = 1 ]; then
      seg 1 printf '%s\n' "/model ds $BENCH_EFFORT" "$(TURN 1)" "$(TURN 2)" "$(TURN 3)" "$(TURN 4)" "$(TURN 5)"
      seg 2 printf '/compact\n'
      seg 3 printf '%s\n' "$(TURN 6)" "$(TURN 7)" "$(TURN 8)"
    else
      seg 1 printf '%s\n' "/model ds $BENCH_EFFORT" "$(TURN 1)" "$(TURN 2)" "$(TURN 3)" "$(TURN 4)" "$(TURN 5)"
      seg 2 printf '%s\n' "$(TURN 6)" "$(TURN 7)" "$(TURN 8)"
    fi
    node -e "
const fs = require('fs');
const { execSync } = require('child_process');
const meta = {
  tool: 'kiso', task: 'T5', run: '$RUN', round: process.env.KISO_ROUND || null,
  model: 'deepseek-flash',
  kisoVersion: '$KISO_VERSION',
  commit: execSync('git -C $B/.. rev-parse --short HEAD').toString().trim(),
  createdAt: Date.now(),
};
fs.writeFileSync('$WORK/meta.json', JSON.stringify(meta, null, 1) + '\n');
"
    ;;
  pi)
    assert_bare pi "$BARE_HOME" || exit 1
    for i in 1 2 3 4 5 6 7 8; do
      over_budget && break
      S=$(date +%s); _left=$(remaining)
      set +e
      bare_bounded "$BARE_HOME" "$_left" "$WORK/stdout-$i.log" \
        "DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY" -- \
        pi --provider deepseek --model deepseek-flash --thinking "$BENCH_EFFORT" -p --mode json \
        --session "$WORK/pi-session" "$(TURN $i)" < /dev/null
      _rc=$?
      set -e
      E=$(date +%s); TOT=$((TOT + E - S))
      printf '%s\n' "$_rc" > "$WORK/exit-$i"
      note_exit "turn $i" "$_rc" "$_left"
    done
    ;;
  claude)
    assert_bare claude "$BARE_HOME" || exit 1
    CCFG="$WORK/claude-config"; mkdir -p "$CCFG"
    # §3: a fresh HOME and CLAUDE_CONFIG_DIR. Without them the arm read the
    # operator's ~/.claude.json and authenticated with THEIR account key —
    # eight 401s recorded as a task failure.
    set -- "CLAUDE_CONFIG_DIR=$CCFG" \
      "ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic" \
      "ANTHROPIC_AUTH_TOKEN=$DEEPSEEK_API_KEY" \
      "ANTHROPIC_MODEL=deepseek-flash" \
      "ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-flash" \
      "ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-flash"
    CLAUDE_ENV_PAIRS="$*"
    SID=""
    for i in 1 2 3 4 5 6 7 8; do
      over_budget && break
      S=$(date +%s); _left=$(remaining)
      if [ -z "$SID" ]; then
        set +e
        bare_bounded "$BARE_HOME" "$_left" "$WORK/stdout-$i.log" \
          $CLAUDE_ENV_PAIRS -- \
          claude -p "$(TURN $i)" --effort "$BENCH_EFFORT" --output-format json --strict-mcp-config --mcp-config '{"mcpServers":{}}' --dangerously-skip-permissions < /dev/null
        _rc=$?; set -e
        printf '%s\n' "$_rc" > "$WORK/exit-$i"
        note_exit "turn $i" "$_rc" "$_left"
        # PARSE PER LINE. Claude Code prints warnings around its result JSON
        # — `[claude-code:unrecognized_model] {...}` is line one here — so
        # `json.load(whole file)` throws and SID stayed empty. Every turn then
        # started a NEW session: eight turns, eight session ids, each
        # re-sending the whole context. Read as a product result that is
        # "Claude Code is 6.8x more expensive on a long session", when no long
        # session ever existed.
        #
        # extract.py already parses per line for exactly this reason. The fix
        # was made there and not here, and nobody asked the sibling.
        SID=$(python3 -c "
import json,sys
for line in open('$WORK/stdout-$i.log', errors='ignore'):
    t=line.strip()
    if not t.startswith('{'): continue
    try: o=json.loads(t)
    except Exception: continue
    if isinstance(o,dict) and o.get('session_id'):
        print(o['session_id']); break
" 2>/dev/null || true)
        [ -n "$SID" ] || echo "WARN: no session_id in turn $i — the next turn cannot resume" >&2
      else
        set +e
        bare_bounded "$BARE_HOME" "$_left" "$WORK/stdout-$i.log" \
          $CLAUDE_ENV_PAIRS -- \
          claude -p "$(TURN $i)" --resume "$SID" --effort "$BENCH_EFFORT" --output-format json --strict-mcp-config --mcp-config '{"mcpServers":{}}' --dangerously-skip-permissions < /dev/null
        _rc=$?; set -e
        printf '%s\n' "$_rc" > "$WORK/exit-$i"
        note_exit "turn $i" "$_rc" "$_left"
      fi
      E=$(date +%s); TOT=$((TOT + E - S))
    done
    ;;
esac
echo "$TOT" > "$WORK/wall_seconds"

# ── the per-arm configuration manifest (§10.3, amendment 4b) ────────────
#
# Written for ALL THREE arms. Before this only kiso got a meta.json, and it
# carried `model: 'deepseek-flash'` as a hardcoded string — a
# SPECIFICATION presented as a MEASUREMENT — plus a `commit` read from the
# host checkout, which is the same defect as the version field: hand the
# runner a pinned published bin and the record names a commit it was never
# built from.
#
# Specified and observed are kept apart. The served model id is read back
# from what the run actually produced; when it cannot be seen, the field is
# null with a reason rather than the specification copied over.
# THE ID WE ASK FOR IS THE ID THE SERVER SERVES.
#
# Every leg until now requested `deepseek-v4-flash`, a RETIRED name the
# vendor still resolves — confirmed on the wire: requested
# `deepseek-v4-flash`, served `deepseek-flash`. Four days of legs carried a
# specification that did not match what ran, and the reconciliation built
# to catch that had no observed half to compare against (TRACE-F1).
#
# `deepseek-flash` is what /models lists and what the vendor's own v4.1
# migration alias resolves to (`deepseek-v4.1-flash-expires-on-0910` ->
# `deepseek-flash`, while the v4-named equivalent is refused). The API
# prints no version string, so that alias topology is the evidence, not a
# vendor statement.
#
# The wire is unchanged: both ids reach the same model. What changes is
# that the manifest stops recording a name nobody serves.
case "$TOOL" in
  kiso)   ARM_CMD="$KISO_BIN"; ARM_MODEL="deepseek-flash"; ARM_ENDPOINT="https://api.deepseek.com"; ARM_ENV="OPENAI_API_KEY OPENAI_BASE_URL OPENAI_MODEL KISO_HOME KISO_EXTENSIONS_DIR" ;;
  # The effort flag belongs IN the captured command. Round B recorded this
  # arm's command as the bare binary name, so the manifest could not show
  # that `--thinking high` was ever sent — the only record of its effort was
  # what the runner INTENDED.
  pi)     ARM_CMD="pi --provider deepseek --model deepseek-flash --thinking $BENCH_EFFORT"; ARM_MODEL="deepseek-flash"; ARM_ENDPOINT="https://api.deepseek.com"; ARM_ENV="DEEPSEEK_API_KEY" ;;
  claude) ARM_CMD="claude";    ARM_MODEL="deepseek-flash"; ARM_ENDPOINT="https://api.deepseek.com/anthropic"; ARM_ENV="ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL" ;;
esac
case "$TOOL" in
  # Amendment 4b: the level is STATED per arm. An arm with no knob states
  # the empty string, which reads as "vendor default" in the manifest —
  # different from an arm that simply forgot to say.
  # all three have the knob: kiso's per-session `/model`, the reference
  # implementation's `--thinking`, Claude Code's `--effort`. Measured on the
  # installed binaries, not read off documentation.
  kiso|pi|claude) ARM_REASONING="$BENCH_EFFORT" ;;
  *)              ARM_REASONING="" ;;
esac
# TRACE-F1-R1: the WHOLE-leg aggregate, not the first answer. A scalar
# could not say "two different models answered this leg", and the manifest
# read that as agreement.
OBSERVED_MODEL_JSON=$(node -e '
import("'"$B"'/observed-model.mjs").then((m) => {
  process.stdout.write(JSON.stringify(m.observedModels(process.argv[1], process.argv[2])));
}).catch(() => process.stdout.write(""));
' "$WORK" "$TOOL" 2>/dev/null || echo "")
export OBSERVED_MODEL_JSON
node --input-type=module -e "
import { captureArm } from '$B/capture-config.mjs';
import { writeFileSync } from 'node:fs';
const observed = {};
const mj = process.env.OBSERVED_MODEL_JSON;
if (mj) { try { observed.model = JSON.parse(mj); } catch {} }
const cfg = captureArm({
  tool: '$TOOL',
  command: '$ARM_CMD'.split(' ').filter(Boolean),
  model: '$ARM_MODEL',
  endpoint: '$ARM_ENDPOINT',
  envNames: '$ARM_ENV'.split(' ').filter(Boolean),
  reasoning: '$ARM_REASONING' === '' ? null : { effort: '$ARM_REASONING' },
  observed,
});
cfg.task = 'T5'; cfg.run = '$RUN'; cfg.round = process.env.KISO_ROUND || null;
cfg.legDeadlineSeconds = $LEG_DEADLINE_S; cfg.legMaxRequests = $LEG_MAX_REQUESTS;
cfg.t5Compact = ${BENCH_T5_COMPACT:-0} === 1;
// WHICH ARM'S EFFORT WAS VERIFIED ON THE WIRE, stated per leg rather than
// left to be inferred. Ours reads its bound level back from the durable
// profile. The other arm has no read-back until request bodies are
// captured, so its level is REQUESTED, not verified — and the manifest
// says which, instead of both arms carrying the same unqualified claim.
cfg.effortVerified = '$TOOL' === 'kiso' ? 'durable-profile' : 'not-verified: the flag is in the command; no read-back exists until request bodies are captured';
writeFileSync('$WORK/config.json', JSON.stringify(cfg, null, 1) + '\n');
" 2>/dev/null || echo "WARN: configuration capture failed for $TOOL" >&2
# F33-R4: execution validity is decided BEFORE the task verdict, and the
# two are kept apart. A leg whose process never ran did not fail the task.
# THE EFFORT MUST BE BOUND, NOT MERELY TYPED. A refused switch runs the
# default and would be scored as this arm's level — the arm would carry a
# label its requests never had. The evidence is the DURABLE PROFILE
# sidecar, which records the binding as a typed field; the screen is not
# evidence, and neither is the trace, which has never carried a `reasoning`
# key on any of the 715 real requests.
EFFORT_BOUND=""
if [ "$TOOL" = "kiso" ]; then
  EFFORT_BOUND=$(node -e '
  const fs=require("fs"),p=require("path");
  const d=process.argv[1]+"/kiso-home/sessions";
  let bound=null;
  try{
    const meta=fs.readdirSync(d).filter(x=>x.endsWith(".meta.json"))[0];
    const j=JSON.parse(fs.readFileSync(p.join(d,meta),"utf8"));
    bound=(j.profile && j.profile.reasoning && j.profile.reasoning.effort) || null;
  }catch{}
  process.stdout.write(bound === null ? "" : String(bound));
  ' "$WORK" 2>/dev/null || echo "")
  printf '%s\n' "${EFFORT_BOUND:-<none>}" > "$WORK/effort_bound"
fi

if [ -f "$WORK/status" ]; then
  : # a budget limit already classified this leg
elif [ -n "$SEG_FAILURE" ]; then
  mark_incomplete "$WORK" "${SEG_FAILURE%%:*}" "${SEG_FAILURE#*:}"
elif [ "$TOOL" = "claude" ] && grep -qi "Unknown --effort value" "$WORK"/stdout-*.log 2>/dev/null; then
  # It warns and then runs the DEFAULT. Unread, that is an arm labelled
  # `high` whose requests were never high — the same silent substitution the
  # kiso check below exists for, except this one announces itself.
  mark_incomplete "$WORK" "effort_not_bound" "the tool rejected --effort $BENCH_EFFORT and used its default"
elif [ "$TOOL" = "kiso" ] && [ "$EFFORT_BOUND" != "$BENCH_EFFORT" ]; then
  # BEFORE the task verdict, like every other execution-validity question:
  # a leg that ran at the wrong level did not fail the task, it failed to
  # be the arm it claims to be.
  # AFTER the run-failure branch above, on purpose: a leg that never ran is
  # not a leg that ran at the wrong level. Reporting the consequence in
  # place of the cause sends the next reader to the wrong question.
  mark_incomplete "$WORK" "effort_not_bound" "wanted $BENCH_EFFORT, the durable profile says ${EFFORT_BOUND:-<none>}"
else
  mark_complete "$WORK"
fi
# Second argument = the sidecar directory: t5-verify.sh writes the
# per-check detail to $WORK/verify.json while `verify` stays one word,
# which is what every consumer reads (extract.py, run-e6hard.sh, ...).
VERIFY=$("$B/t5-verify.sh" "$WORK/repo" "$WORK")
echo "$VERIFY" > "$WORK/verify"
echo "DONE T5 $TOOL run=$RUN wall=${TOT}s verify=$VERIFY"
