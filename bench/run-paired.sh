#!/bin/sh
# run-paired.sh <task: T3|T5|L1|L2|F1> <pairs> — one paired set of the
# 0.46.0 evaluation (kiso-doc plan-0460-3f-evaluation; BM-1).
#
# run-ceremony.sh's discipline, for any task: the rc against the PUBLISHED
# previous release, interleaved, the order alternating inside each pair, a
# leg whose recorded version is not its arm's VOID (reported, never
# rescored). Added for this round:
#
#   - the CACHE-COLLAPSE rule (the Command Code route): a leg whose cache
#     hit is under 0.70 while its pair's other leg is at 0.90 or more is a
#     gateway incident — the PAIR is void and re-run at the end (run ids
#     rc<N>b / ctl<N>b); more than three void pairs stops the set;
#   - the SPEND CAP: before each pair, the round's spend so far (every
#     leg's own usage, round-spend.mjs) is read; past BENCH_SPEND_CAP_USD
#     the set stops and says where.
set -eu
TASK=${1:?usage: run-paired.sh <task> <pairs>}
PAIRS=${2:?usage: run-paired.sh <task> <pairs>}
B="$(cd "$(dirname "$0")" && pwd)"
: "${KISO_BIN_RC:?set KISO_BIN_RC to the release candidate}"
: "${KISO_BIN_CTL:?set KISO_BIN_CTL to the published previous release}"
: "${RC_VERSION:?set RC_VERSION}"
: "${CTL_VERSION:?set CTL_VERSION}"
ROUND=${KISO_ROUND:-paired}
CAP=${BENCH_SPEND_CAP_USD:-5}
. "$B/leg-isolation.sh"
ROOT="$(runs_root "$B")/$ROUND"
mkdir -p "$ROOT"

want_ver() { [ "$1" = rc ] && echo "$RC_VERSION" || echo "$CTL_VERSION"; }
bin_for()  { [ "$1" = rc ] && echo "$KISO_BIN_RC" || echo "$KISO_BIN_CTL"; }
leg_dir()  { echo "$ROOT/kiso-$TASK-$1"; }

VOID=0
run_leg() {
	ARM=$1; RUN=$2
	echo "--- $TASK $RUN ($ARM)"
	if [ "$TASK" = T5 ]; then
		KISO_ROUND="$ROUND" KISO_BIN="$(bin_for "$ARM")" KISO_VERSION="" sh "$B/run-t5.sh" kiso "$RUN" || echo "    (runner exited non-zero; its status file is the record)"
	else
		KISO_ROUND="$ROUND" KISO_BIN="$(bin_for "$ARM")" KISO_VERSION="" sh "$B/run-task.sh" "$TASK" "$RUN" || echo "    (runner exited non-zero; its status file is the record)"
	fi
	W=$(leg_dir "$RUN")
	SAW=$(node -e 'try { console.log(String(JSON.parse(require("fs").readFileSync(process.argv[1] + "/meta.json", "utf8")).kisoVersion ?? "missing")); } catch { console.log("missing"); }' "$W" 2>/dev/null || echo missing)
	WANT=$(want_ver "$ARM")
	# EXACT (0.48.0 kit §2): a substring match let 0.48.0 pass for 0.48.0-rc.1
	if [ "$SAW" != "$WANT" ]; then
		printf 'VOID: launched as %s, its meta records %s (wanted exactly %s)\n' "$ARM" "$SAW" "$WANT" > "$W/void"
		echo "    VOID — wanted exactly $WANT, the leg records $SAW"; VOID=$((VOID + 1))
	fi
}

hit_of() { node -e 'import(process.argv[1]).then((m) => { const h = m.counters(process.argv[2]).cacheHit; console.log(h === null ? "-1" : String(h)); })' "$B/tasks-counters.mjs" "$1" 2>/dev/null || echo -1; }

# collapse <rcRun> <ctlRun>: true when the pair is a gateway incident
collapse() {
	_a=$(hit_of "$(leg_dir "$1")"); _b=$(hit_of "$(leg_dir "$2")")
	node -e 'const [a, b] = process.argv.slice(1).map(Number); process.exit((a >= 0 && b >= 0) && ((a < 0.7 && b >= 0.9) || (b < 0.7 && a >= 0.9)) ? 0 : 1)' "$_a" "$_b"
}

over_cap() {
	_s=$(node "$B/round-spend.mjs" "$ROOT")
	node -e 'process.exit(Number(process.argv[1]) > Number(process.argv[2]) ? 0 : 1)' "$_s" "$CAP" && { echo "SPEND CAP: \$$_s spent, cap \$$CAP — the set stops here"; return 0; }
	return 1
}

pair() { # pair <index> <suffix>
	_i=$1; _sfx=$2
	if [ $((_i % 2)) -eq 1 ]; then FIRST=ctl; SECOND=rc; else FIRST=rc; SECOND=ctl; fi
	run_leg "$FIRST" "$FIRST$_i$_sfx"
	run_leg "$SECOND" "$SECOND$_i$_sfx"
	if collapse "rc$_i$_sfx" "ctl$_i$_sfx"; then
		for a in rc ctl; do printf 'VOID: cache collapse in pair %s%s (one leg under 0.70 hit, the other at 0.90 or more) — a gateway incident, re-run\n' "$_i" "$_sfx" > "$(leg_dir "$a$_i$_sfx")/void"; done
		echo "    VOID PAIR $_i$_sfx — cache collapse; re-run at the end"
		return 1
	fi
	return 0
}

RERUN=""
NVOIDPAIRS=0
I=1
STOPPED=""
# PAIR_LIST (0.48.0 kit §7): re-run exactly these pairs, under PAIR_SUFFIX
# (default c) — the pairs audit-legs.mjs voided after the set. A void pair in
# this mode is reported, never run a further time.
if [ -n "${PAIR_LIST:-}" ]; then
	for I in $PAIR_LIST; do
		if over_cap; then STOPPED=cap; break; fi
		pair "$I" "${PAIR_SUFFIX:-c}" || { echo "    the re-run of pair $I is void too — reported, not run a further time"; NVOIDPAIRS=$((NVOIDPAIRS + 1)); }
	done
	PAIRS="list:$PAIR_LIST"
	I=999999
fi
while [ -z "${PAIR_LIST:-}" ] && [ "$I" -le "$PAIRS" ]; do
	if over_cap; then STOPPED=cap; break; fi
	if ! pair "$I" ""; then RERUN="$RERUN $I"; NVOIDPAIRS=$((NVOIDPAIRS + 1)); fi
	if [ "$NVOIDPAIRS" -gt 3 ]; then echo "MORE THAN THREE VOID PAIRS — the set stops; the gateway is not fit for this round"; STOPPED=voids; break; fi
	I=$((I + 1))
done
if [ -z "$STOPPED" ] && [ -z "${PAIR_LIST:-}" ]; then
	for I in $RERUN; do
		if over_cap; then STOPPED=cap; break; fi
		pair "$I" b || echo "    the re-run of pair $I is void too — reported, not run a third time"
	done
fi
echo
echo "$TASK: pairs $PAIRS   void legs (version): $VOID   void pairs (cache): $NVOIDPAIRS${STOPPED:+   STOPPED: $STOPPED}   spent: \$$(node "$B/round-spend.mjs" "$ROOT")"
[ "$VOID" -eq 0 ] || echo "A VOID LEG IS NOT A DATA POINT. Fix the wiring and re-run rather than scoring around one."
