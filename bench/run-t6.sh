#!/bin/sh
# run-t6.sh <tool: kiso|pi|claude> <run-id>
#   (BENCH_INSTANCE=<materialized instance dir> runs one concealed-set
#   instance through the same apparatus instead — see THE SCENARIO below)
# The long-curve scenario: 24 progressive turns on fixture-t6, split into
# FOUR 6-turn buckets. Each tool drives the session with its NATIVE
# mechanism (the T5 pattern, scaled):
#   kiso   — 4 processes on one durable session, 6 piped prompts each. The
#            process boundaries ARE the bucket boundaries, so each process's
#            wall is the bucket's wall; the resume cost of a process lands
#            in its bucket's first turn (the mechanism's honest price).
#   pi     — 24 `-p` invocations sharing one --session file; the runner sums
#            the per-invocation walls into the same per-bucket wall files.
#   claude — 24 `-p` invocations sharing one --resume session, same sums.
# Wall is per-bucket (wall_1..wall_4); usage extraction is per-bucket too
# (extract-t6.py): the divergence curve needs the cost GROWTH over the
# session, not just the total.
#
# PORTED 2026-09-15 to the T5 runner's apparatus, which it was eight
# generations behind. It had: no bare-HOME isolation (an arm read the
# operator's own config — the §3 finding), NO per-leg deadline or request
# ceiling at all, `|| true` on every invocation so a launch failure was
# indistinguishable from a clean run, the retired model id, no version
# probe, no configuration manifest, no completion classification, and no
# third arm — while axis 3 is defined in TRIPLETS.
#
# Running it as it stood would have spent money with no bound, which is
# precisely what the T5 limits exist to prevent. Everything below comes
# from run-t5.sh rather than being written again: one apparatus, two
# scenarios.
set -eu
TOOL=$1; RUN=$2
B="$(cd "$(dirname "$0")" && pwd)"
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
# LB-1: legs live under the runs root — KISO_RUNS_ROOT when set (the launch
# bench keeps them outside any checkout; see leg-isolation.sh), else runs/.
. "$B/leg-isolation.sh"
# THE SCENARIO. Unset BENCH_INSTANCE = T6 exactly as it was (fixture-t6, its
# 24 turns in four buckets of six, t6-verify.sh). Set = ONE generated
# instance of the launch bench's concealed set — a `cli.mjs materialize`
# directory — with its own fixture, its own N turns (buckets of six, the
# last one short), and its own held-out verifier fed the leg's final text.
# One apparatus: the limits, the bareness, the capture, the manifest and the
# completion classification are the T6 ones either way.
INSTANCE=${BENCH_INSTANCE:-}
# THE ANSWER IS NEVER ON DISK WHILE AN ARM RUNS. A materialized instance
# carries its verifier (the pristine fixture, the REFERENCE SOLUTION, the
# negative controls) and instance.json (B+D's parameters name the defect).
# The launch driver therefore hands the leg a STAGED instance — fixture/ and
# tasks.json only, id in BENCH_INSTANCE_ID — and the verifier is
# materialized again from the seed (BENCH_INSTANCE_SEED; generation is
# deterministic) into a throwaway directory after the arm has exited, and
# deleted after the verdict. A full materialized directory (the offline
# smoke's) still works: its verifier is used where it lies.
if [ -n "$INSTANCE" ]; then
  FIXTURE="$INSTANCE/fixture"; TASKS="$INSTANCE/tasks.json"
  if [ -n "${BENCH_INSTANCE_ID:-}" ]; then
    LABEL=$BENCH_INSTANCE_ID
  else
    LABEL=$(node -e 'process.stdout.write(String(require(process.argv[1]).id))' "$INSTANCE/instance.json")
  fi
else
  FIXTURE="$B/fixture-t6"; TASKS="$B/tasks-t6.json"; LABEL=T6
fi
NTURNS=$(node -e 'process.stdout.write(String(require(process.argv[1]).length))' "$TASKS")
NBUCKETS=$(( (NTURNS + 5) / 6 ))
WORK="$(runs_root "$B")/${KISO_ROUND:+$KISO_ROUND/}$TOOL-$LABEL-$RUN"
rm -rf "$WORK"; mkdir -p "$WORK"
cp -R "$FIXTURE/" "$WORK/repo/"
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
# The two pre-flight gates, BEFORE any request is spent: git resolves to
# this repo, and no ancestor carries an instruction file (leg-isolation.sh).
if ! assert_leg_isolated "$WORK" "$WORK/repo"; then
  echo "$(cat "$WORK/void")" >&2
  exit 3
fi
# THE KEY NEVER ENTERS ANY ARGV (the owner's rule). The runner holds only
# the credentials file's PATH; cred-exec.sh reads the key inside the process
# that becomes the arm. The file must exist and name the key; nothing here
# reads the value.
# 2026-10-07: the ROUTE decides the file and the variable in it (route.sh),
# as run-t5.sh has since 3f; the reference arm runs on any route, the third
# arm on the official endpoint only.
. "$B/route.sh"
if [ "$BENCH_ROUTE" != ds ] && [ "$TOOL" = claude ]; then
  echo "BENCH_ROUTE=$BENCH_ROUTE is for the kiso and reference arms only" >&2; exit 1
fi
CRED_FILE="$ROUTE_CRED_FILE"
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
# THE ROUND'S REASONING LEVEL, pinned for every arm that has the knob —
# the same constant and the same reasoning as run-t5.sh (Amendment 4b).
BENCH_EFFORT=${BENCH_EFFORT:-high}
TURN() { node -e "console.log(JSON.parse(require('fs').readFileSync('$TASKS','utf8'))[$1-1])"; }
BUCKET() { # $1=1..4 — the turn range's start and end
  P=$1; S=$(( (P - 1) * 6 + 1 )); E=$(( P * 6 )); [ "$E" -le "$NTURNS" ] || E=$NTURNS
  i=$S; while [ "$i" -le "$E" ]; do TURN $i; i=$((i + 1)); done
}

# Per-bucket wall for the arms that invoke per TURN: sum each bucket's six
# turns into the same wall_N files kiso writes directly, so the divergence
# curve reads one shape for all three.
BUCKET_WALLS() {
  P=1; while [ "$P" -le "$NBUCKETS" ]; do
    TOT=0; i=$(( (P - 1) * 6 + 1 )); E=$(( P * 6 )); [ "$E" -le "$NTURNS" ] || E=$NTURNS
    while [ "$i" -le "$E" ]; do
      # a turn the budget stopped before has no wall file; count it as zero
      # rather than failing under `set -u` — a short leg is a recorded
      # outcome, not a runner error
      [ -f "$WORK/wall_turn_$i" ] && TOT=$((TOT + $(cat "$WORK/wall_turn_$i")))
      rm -f "$WORK/wall_turn_$i" # ONLY this turn — a glob here would
      i=$((i + 1))               # wipe later buckets' walls (the run bug)
    done
    echo "$TOT" > "$WORK/wall_$P"
    P=$((P + 1))
  done
}

# One classifier for three arms, as in run-t5.sh: SEG_FAILURE is declared
# ABOVE the arm switch because the completion decision at the end is shared
# (F33-R6 — it lived inside one arm there, and `set -u` killed the other two
# after their work was done).
SEG_FAILURE=""
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
    assert_bare kiso "$BARE_HOME" || exit 1
    # The named profile `/model` needs — without it the effort line is
    # refused on every leg and the leg is marked effort_not_bound, which is
    # the gate working and the round wasted.
    mkdir -p "$WORK/kiso-home"
    route_profile_json > "$WORK/kiso-home/config.json"
    set -- "OPENAI_BASE_URL=$ROUTE_BASE_URL" "BENCH_CRED_FILE=$CRED_FILE" "BENCH_CRED_AS=OPENAI_API_KEY" "BENCH_CRED_KEY=$ROUTE_CRED_KEY" \
      "OPENAI_MODEL=$ROUTE_MODEL" "KISO_EXTENSIONS_DIR=$EXTDIR" \
      "KISO_HOME=$WORK/kiso-home" "KISO_SESSIONS_DIR=$WORK/kiso-home/sessions" "KISO_SKILLS_DIR=$SKILLDIR" "KISO_NO_UPDATE_CHECK=1"
    # EDIT-ECHO A/B: the ONLY difference between the two arms of that
    # experiment. Same binary, same model, same effort, same prompts — one
    # arm is told what its edit produced and the other is not. The switch
    # is on the PRODUCT side (KISO_EDIT_ECHO), never on the task side.
    #
    # THE PRODUCT SWITCH IS RETIRED (the round did not support adoption;
    # it did not refute the mechanism, having no resolution to refute
    # with). This plumbing is kept for a properly powered revival and is
    # NOT silently dead: against a build without the switch, the binding
    # check below reads `edit_echo=off` on a leg that asked for `on`, and
    # the leg is VOID rather than quietly joining the control arm.
    if [ "${BENCH_EDIT_ECHO:-0}" = 1 ]; then set -- "$@" "KISO_EDIT_ECHO=1"; fi
    # CAPTURE: our arm dumps its OWN bodies. It must NOT go through a proxy —
    # a loopback baseUrl defeats the endpoint-keyed metadata lookup
    # (dispatch.ts: lookupModelMetadata(model, baseUrl)), so `/model ds high`
    # is refused and every leg reads effort_not_bound. The round would be
    # void, after the money.
    if [ "${BENCH_CAPTURE:-0}" = 1 ]; then
      mkdir -p "$WORK/capture"
      set -- "$@" "KISO_DUMP_REQUESTS=$WORK/capture"
    fi
    # ROUND A: the default table without `delegate`, through the product's
    # OWN code path — the subagent extension's depth guard returns no tools
    # at depth >= 1. One environment variable, the same binary, no shadowing
    # extension and no config file, so the two arms differ in exactly one
    # thing and neither is a build the product does not ship.
    #
    # The arm APPROXIMATES A DEFERRED DESIGN, not a removal: the owner has
    # ruled the capability must never require manual configuration.
    if [ "${BENCH_NO_DELEGATE:-0}" = 1 ]; then set -- "$@" "KISO_SUBAGENT_DEPTH=1"; fi
    KISO_ENV_PAIRS="$*"
    P=1; while [ "$P" -le "$NBUCKETS" ]; do
      over_budget && break
      S=$(date +%s); _left=$(remaining)
      set +e
      # bucket 1 opens with the effort switch, the way a human sets it —
      # unless the round runs at the provider's default (`none`, run-t5.sh)
      if [ "$P" -eq 1 ] && [ "$BENCH_EFFORT" != none ]; then
        { printf '%s\n' "/model ds $BENCH_EFFORT"; BUCKET $P; } | bare_bounded "$BARE_HOME" "$_left" "$WORK/stdout-$P.log" \
          $KISO_ENV_PAIRS -- sh "$B/cred-exec.sh" $KISO_BIN --mode bypass "bench-t6-$TOOL-$RUN"
      else
        BUCKET $P | bare_bounded "$BARE_HOME" "$_left" "$WORK/stdout-$P.log" \
          $KISO_ENV_PAIRS -- sh "$B/cred-exec.sh" $KISO_BIN --mode bypass "bench-t6-$TOOL-$RUN"
      fi
      _rc=$?; set -e
      E=$(date +%s); echo $((E - S)) > "$WORK/wall_$P"
      printf '%s\n' "$_rc" > "$WORK/exit-$P"
      note_exit "bucket $P" "$_rc" "$_left"
      P=$((P + 1))
    done
    # the leg's own record of the binary it ran, as run-t5.sh writes it: the
    # paired runner voids a leg whose meta does not name its arm's version
    node -e "
const fs = require('fs');
fs.writeFileSync('$WORK/meta.json', JSON.stringify({
  tool: 'kiso', task: '$LABEL', run: '$RUN', round: process.env.KISO_ROUND || null,
  model: '$ROUTE_MODEL', route: '$BENCH_ROUTE', kisoVersion: '$KISO_VERSION', createdAt: Date.now(),
}, null, 1) + '\\n');
"
    ;;
  pi)
    # THE ROUTE, as run-t5.sh: ds uses the arm's built-in provider with its
    # key in its environment (cred-exec); any other route a custom provider
    # in its MODEL STORE, keyed by a command (route.sh). CAPTURE: this arm
    # has no dump sink, so the proxy records for it; its base URL moves via
    # the store (environment variables are not honoured — the older note
    # stands). The store is DECLARED to the bareness gate, which still fails
    # on anything undeclared.
    CAPTURE_DECL=""
    if [ "$BENCH_ROUTE" = ds ]; then
      if [ "${BENCH_CAPTURE:-0}" = 1 ]; then
        mkdir -p "$WORK/capture" "$BARE_HOME/.pi/agent"
        CAP_UP=${CAP_UPSTREAM:-api.deepseek.com}
        CAP_PORT=$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,()=>{console.log(s.address().port);s.close();});')
        python3 "$B/capture-proxy.py" --port "$CAP_PORT" --upstream "$CAP_UP" --scheme https --out "$WORK/capture" --label "pi-$RUN" >/dev/null 2>&1 &
        CAP_PID=$!
        sleep 2
        node -e '
          const fs = require("fs");
          const src = process.env.HOME + "/.pi/agent/models-store.json";
          const d = JSON.parse(fs.readFileSync(src, "utf8"));
          // metadata only — this file carries no credential (checked); the key
          // rides in the environment, as it does without the proxy
          for (const m of (d.deepseek && d.deepseek.models) || []) m.baseUrl = process.argv[1];
          fs.writeFileSync(process.argv[2], JSON.stringify(d));
        ' "http://127.0.0.1:$CAP_PORT" "$BARE_HOME/.pi/agent/models-store.json"
        CAPTURE_DECL=".pi/agent/models-store.json"
      fi
    else
      mkdir -p "$BARE_HOME/.pi/agent"
      REF_BASE="$ROUTE_BASE_URL"
      if [ "${BENCH_CAPTURE:-0}" = 1 ]; then
        mkdir -p "$WORK/capture"
        CAP_PORT=$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,()=>{console.log(s.address().port);s.close();});')
        python3 "$B/capture-proxy.py" --port "$CAP_PORT" --upstream "$ROUTE_HOST" --scheme https --out "$WORK/capture" --label "pi-$RUN" >/dev/null 2>&1 &
        CAP_PID=$!
        sleep 2
        REF_BASE="http://127.0.0.1:$CAP_PORT$ROUTE_PATH"
      fi
      route_ref_models_json "$REF_BASE" "$B/cred-print.sh" "ref-$RUN-$$" > "$BARE_HOME/.pi/agent/models.json"
      CAPTURE_DECL=".pi/agent/models.json"
    fi
    assert_bare pi "$BARE_HOME" $CAPTURE_DECL || exit 1
    i=1; while [ "$i" -le "$NTURNS" ]; do
      over_budget && break
      S=$(date +%s); _left=$(remaining)
      set +e
      if [ "$BENCH_ROUTE" = ds ]; then
        bare_bounded "$BARE_HOME" "$_left" "$WORK/stdout-$i.log" \
          "BENCH_CRED_FILE=$CRED_FILE" "BENCH_CRED_AS=DEEPSEEK_API_KEY" -- \
          sh "$B/cred-exec.sh" "$REF_BIN" --provider deepseek --model deepseek-flash --thinking "$REF_THINKING" -p --mode json \
          --session "$WORK/pi-session" "$(TURN $i)" < /dev/null
      else
        bare_bounded "$BARE_HOME" "$_left" "$WORK/stdout-$i.log" -- \
          "$REF_BIN" --provider route --model "$ROUTE_MODEL" --thinking "$REF_THINKING" -p --mode json \
          --session "$WORK/pi-session" "$(TURN $i)" < /dev/null
      fi
      _rc=$?; set -e
      E=$(date +%s); echo $((E - S)) > "$WORK/wall_turn_$i"
      printf '%s\n' "$_rc" > "$WORK/exit-$i"
      note_exit "turn $i" "$_rc" "$_left"
      i=$((i + 1))
    done
    BUCKET_WALLS
    [ -n "${CAP_PID:-}" ] && kill "$CAP_PID" 2>/dev/null
    ;;
  claude)
    CCFG="$WORK/claude-config"; mkdir -p "$CCFG"
    assert_bare claude "$BARE_HOME" || exit 1
    set -- "CLAUDE_CONFIG_DIR=$CCFG" \
      "ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic" \
      "BENCH_CRED_FILE=$CRED_FILE" "BENCH_CRED_AS=ANTHROPIC_AUTH_TOKEN" \
      "ANTHROPIC_MODEL=deepseek-flash" \
      "ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-flash" \
      "ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-flash"
    CLAUDE_ENV_PAIRS="$*"
    SID=""
    i=1; while [ "$i" -le "$NTURNS" ]; do
      over_budget && break
      S=$(date +%s); _left=$(remaining)
      set +e
      if [ -z "$SID" ]; then
        bare_bounded "$BARE_HOME" "$_left" "$WORK/stdout-$i.log" $CLAUDE_ENV_PAIRS -- \
          sh "$B/cred-exec.sh" claude -p "$(TURN $i)" --effort "$BENCH_EFFORT" --output-format json --strict-mcp-config --mcp-config '{"mcpServers":{}}' --dangerously-skip-permissions < /dev/null
      else
        bare_bounded "$BARE_HOME" "$_left" "$WORK/stdout-$i.log" $CLAUDE_ENV_PAIRS -- \
          sh "$B/cred-exec.sh" claude -p "$(TURN $i)" --resume "$SID" --effort "$BENCH_EFFORT" --output-format json --strict-mcp-config --mcp-config '{"mcpServers":{}}' --dangerously-skip-permissions < /dev/null
      fi
      _rc=$?; set -e
      E=$(date +%s); echo $((E - S)) > "$WORK/wall_turn_$i"
      printf '%s\n' "$_rc" > "$WORK/exit-$i"
      note_exit "turn $i" "$_rc" "$_left"
      # PARSE PER LINE — this arm prints warnings around its result JSON.
      if [ -z "$SID" ]; then
        SID=$(python3 -c "
import json, sys
for line in open('$WORK/stdout-$i.log', errors='ignore'):
    t = line.strip()
    i0 = t.find('{')
    if i0 < 0: continue
    try: o = json.loads(t[i0:])
    except Exception: continue
    if isinstance(o, dict) and o.get('session_id'):
        print(o['session_id']); break
" 2>/dev/null || true)
        [ -n "$SID" ] || echo "WARN: no session_id in turn $i — the next turn cannot resume" >&2
      fi
      i=$((i + 1))
    done
    BUCKET_WALLS
    ;;
  *)
    echo "usage: run-t6.sh <kiso|pi|claude> <run-id>" >&2; exit 1
    ;;
esac

case "$TOOL" in
  kiso)   ARM_CMD="$KISO_BIN"; ARM_MODEL="$ROUTE_MODEL"; ARM_ENDPOINT="$ROUTE_BASE_URL"; ARM_ENV="OPENAI_API_KEY OPENAI_BASE_URL OPENAI_MODEL KISO_HOME KISO_EXTENSIONS_DIR" ;;
  pi)     if [ "$BENCH_ROUTE" = ds ]; then
            ARM_CMD="$REF_BIN --provider deepseek --model deepseek-flash --thinking $REF_THINKING"; ARM_ENV="DEEPSEEK_API_KEY"
          else
            ARM_CMD="$REF_BIN --provider route --model $ROUTE_MODEL --thinking $REF_THINKING"; ARM_ENV=""
          fi
          ARM_MODEL="$ROUTE_MODEL"; ARM_ENDPOINT="$ROUTE_BASE_URL" ;;
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
cfg.task = '$LABEL'; cfg.run = '$RUN'; cfg.round = process.env.KISO_ROUND || null;
cfg.route = '$BENCH_ROUTE';
cfg.legDeadlineSeconds = $LEG_DEADLINE_S; cfg.legMaxRequests = $LEG_MAX_REQUESTS;
cfg.editEchoRequested = '$TOOL' === 'kiso' ? ${BENCH_EDIT_ECHO:-0} === 1 : null;
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
  # AND THE ECHO MUST BE BOUND, NOT MERELY REQUESTED. Setting
  # KISO_EDIT_ECHO=1 against a binary that predates the switch produces a
  # leg LABELLED B that behaved exactly like A — the experiment destroyed
  # silently, with both arms agreeing because they were the same arm. So
  # the evidence is what the edit results ACTUALLY carried: a successful
  # edit_file whose result has an `@@ a-b @@` header. Three values, and
  # `none` is not `off`: a leg that never edited anything cannot testify.
  EDIT_ECHO_OBSERVED=$(node -e '
  const fs=require("fs"),p=require("path");
  const d=process.argv[1]+"/kiso-home/sessions";
  let names={},saw=0,edits=0;
  try{
    const f=fs.readdirSync(d).find(x=>x.endsWith(".jsonl")&&!x.includes("trace"));
    for(const line of fs.readFileSync(p.join(d,f),"utf8").split("\n")){
      if(!line.trim())continue; let o; try{o=JSON.parse(line);}catch{continue}
      const e=o.event||o;
      if(e.type==="tool_call_start")names[e.callId]=e.name;
      if(e.type==="tool_result"&&names[e.callId]==="edit_file"&&!e.isError){
        edits++; if(/^@@ \d+-\d+ @@$/m.test(String(e.content||"")))saw++; }
    }
  }catch{}
  process.stdout.write(edits===0?"none":(saw>0?"on":"off"));
  ' "$WORK" 2>/dev/null || echo "unknown")
  printf '%s\n' "$EDIT_ECHO_OBSERVED" > "$WORK/edit_echo"
  # WHICH TABLE THE LEG ACTUALLY CARRIED, read from its own captured bodies
  # rather than from what the runner was asked to do. A leg labelled A whose
  # table still carries `delegate` is not an A leg, and the label would make
  # both arms agree because they were the same arm.
  if [ "${BENCH_CAPTURE:-0}" = 1 ]; then
    node --input-type=module -e "
      import { readCapture } from '$B/reconcile-capture.mjs';
      import { writeFileSync } from 'node:fs';
      const recs = readCapture('$WORK/capture').filter((r) => r.body?.tools);
      if (recs.length === 0) { writeFileSync('$WORK/tool_table', 'unknown\n'); process.exit(0); }
      const names = (recs[0].body.tools ?? []).map((t) => t.function?.name ?? t.name).sort();
      writeFileSync('$WORK/tool_table', names.join(',') + '\n');
    " 2>/dev/null || printf 'unknown\n' > "$WORK/tool_table"
    # WHICH PROMPT THE LEG ACTUALLY CARRIED, on the same principle. The arm
    # of the re-read round is one bullet of the system prompt, and the
    # runner selects it by KISO_BIN — a build path, which is exactly the
    # kind of label that can be wrong while every number still looks fine.
    # This reads the system message off the leg's own first captured body.
    node --input-type=module -e "
      import { readCapture } from '$B/reconcile-capture.mjs';
      import { writeFileSync } from 'node:fs';
      const recs = readCapture('$WORK/capture').filter((r) => Array.isArray(r.body?.messages));
      const sysOf = (r) => {
        const m = r.body.messages.find((x) => x.role === 'system');
        if (!m) return '';
        return typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join('');
      };
      const sys = recs.map(sysOf).find((t) => t.length > 0) ?? '';
      const extended = /or one you changed\s*\n?\s*yourself through a confirmed edit/i.test(sys);
      const published = /do not re-?read a file you already read unchanged/i.test(sys);
      // 'unknown' when neither clause is present: a prompt that carries
      // neither is not one of this round's two arms, whatever was launched.
      writeFileSync('$WORK/prompt_arm', (extended ? 'exemption-extended' : published ? 'published' : 'unknown') + '\n');
    " 2>/dev/null || printf 'unknown\n' > "$WORK/prompt_arm"
  fi
  printf '%s\n' "${BENCH_EDIT_ECHO:-0}" > "$WORK/edit_echo_requested"
fi

# CAPTURE RECONCILIATION, both arms, before any verdict is read off this leg.
#
# A directory of bodies proves nothing alone: if the sink missed requests,
# the bodies describe a DIFFERENT session from the one the usage numbers
# came from. And the effort read from a body is the WIRE-VERIFIED level —
# the thing this programme has never had for the arm without a durable
# profile, which carried "requested, not verified" on every leg ever run.
if [ "${BENCH_CAPTURE:-0}" = 1 ]; then
  node --input-type=module -e "
    import { readCapture, reconcile } from '$B/reconcile-capture.mjs';
    import { readFileSync, writeFileSync } from 'node:fs';
    let requests = null;
    try {
      const cfg = JSON.parse(readFileSync('$WORK/config.json', 'utf8'));
      requests = cfg.model && typeof cfg.model.requests === 'number' ? cfg.model.requests : null;
    } catch {}
    const recs = readCapture('$WORK/capture');
    const r = reconcile(recs, { requests, model: '$ROUTE_MODEL', effort: '$BENCH_EFFORT' });
    writeFileSync('$WORK/capture.json', JSON.stringify(r, null, 1) + '\n');
    // the wire-verified effort is its own sidecar, beside effort_bound, so a
    // reader never has to infer which arm's claim rests on what
    writeFileSync('$WORK/effort_wire', (r.effortObserved && r.effortObserved.length ? String(r.effortObserved) : 'not-observed') + '\n');
  " 2>/dev/null || { echo "reconcile-failed" > "$WORK/effort_wire"; echo '{\"ok\":false,\"problems\":[\"the reconciler did not run\"]}' > "$WORK/capture.json"; }
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
elif [ "$TOOL" = "kiso" ] && [ "$BENCH_EFFORT" != none ] && [ "$EFFORT_BOUND" != "$BENCH_EFFORT" ]; then
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
# The second argument is the sidecar directory: t6-verify.sh writes the
# per-check detail to $WORK/verify.json while `verify` stays one word, which
# is what every consumer of it reads (extract-t6.py, run-e6hard.sh, ...).
if [ -n "$INSTANCE" ]; then
  # THE CONCEALED VERDICT. First the leg's FINAL text, from the arm's own
  # record (final-answer.mjs) — every leg writes it, family E reads it; an
  # empty read is a failed read (`answer_status: unread`), never an empty
  # answer. Then the instance's held-out verifier, which prints ONE word and
  # exits 0 either way: a non-zero exit means it could not run, and the leg
  # reads `error` — not `fail`, which would charge the arm for our apparatus.
  ANSWER_ARG=""
  if node "$B/final-answer.mjs" "$TOOL" "$WORK" 2> "$WORK/answer.err"; then
    printf 'read\n' > "$WORK/answer_status"; ANSWER_ARG="--answer $WORK/answer.txt"
  else
    printf 'unread\n' > "$WORK/answer_status"
  fi
  VDIR="$INSTANCE"; HELD=""
  if [ ! -d "$INSTANCE/verifier" ]; then
    HELD=$(mktemp -d)
    VDIR="$HELD/instance"
    node "$B/concealed/cli.mjs" materialize --seed "${BENCH_INSTANCE_SEED:?a staged instance needs its seed to verify}" --instance "$LABEL" --out "$VDIR" > /dev/null 2>> "$WORK/verify.err" || VDIR=""
  fi
  if [ -n "$VDIR" ]; then
    VERIFY=$(node "$B/concealed/cli.mjs" verify --instance-dir "$VDIR" --workspace "$WORK/repo" $ANSWER_ARG --out "$WORK" 2>> "$WORK/verify.err") || VERIFY=error
  else
    VERIFY=error
  fi
  [ -n "$HELD" ] && rm -rf "$HELD"
  [ -n "$VERIFY" ] || VERIFY=error
else
  VERIFY=$("$B/t6-verify.sh" "$WORK/repo" "$WORK")
fi
echo "$VERIFY" > "$WORK/verify"
echo "DONE $LABEL $TOOL run=$RUN verify=$VERIFY"
