#!/bin/sh
# Round B, re-run — six interleaved pairs, kiso against the reference
# implementation, three on T5 and three on T6.
#
# WHAT CHANGED SINCE THE FIRST RUN, all of it declared before the first leg:
#
#  1. PER-LEG REPOSITORY. The first run deleted the fixture's .git and
#     stopped there, so the fixture sat inside the host repository and git
#     WALKED UP. Exactly one leg of the twelve ever ran git — and it ran 34
#     `git stash`, reached the operator's worktree, and popped their parked
#     stash. 98.6% of that leg's reasoning came after the conflict. The
#     other eleven never touched git, so this fix repairs ONE leg's world;
#     the rest of this round's value is a second sample on a fixed index.
#
#  2. NO SINGLE-ARM COMPACTION. The first run sent `/compact` to our arm and
#     to no other. It cost exactly one cache break per T5 leg, all at turn
#     6, the prefix collapsing to the same 2,304 floor, that one request
#     carrying 30-50% of the leg's whole fresh input. Off by default now.
#
#  3. THE EFFORT FLAG IS IN THE CAPTURED COMMAND for both arms, and the
#     manifest says per leg WHICH arm's level was verified on the wire.
#     Ours reads back from the durable profile. The other arm has no
#     read-back until request bodies are captured, so its level is recorded
#     as REQUESTED — not as verified, and not silently as the same thing.
#
#  4. THE VERIFIER asks three questions rather than one (contract, held-out
#     boundary, scope) and `pass` means something narrower than it did.
#     VERIFY_PREDICATE travels with every verdict; a pass rate from before
#     2026-09-15 and one from after are answers to different questions.
#
# NOT CHANGED: six interleaved pairs, ABBA order, the frozen criteria, the
# effort pin, the model, the endpoint, the tasks.
set -eu
B="$(cd "$(dirname "$0")" && pwd)"
: "${DEEPSEEK_API_KEY:?set DEEPSEEK_API_KEY before running}"
export KISO_ROUND=${KISO_ROUND:-roundb-rerun}
export KISO_BIN="${KISO_BIN:-node /private/tmp/kiso-meter/apps/cli/dist/index.js}"
export KISO_VERSION=${KISO_VERSION:-0.36.0-roundb.local}
export BENCH_EFFORT=${BENCH_EFFORT:-high}
export BENCH_T5_COMPACT=${BENCH_T5_COMPACT:-0}

say() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$1"; }

check_leg() { # $1=task(T5|T6)  $2=tool  $3=run-id
	W="$B/runs/$KISO_ROUND/$2-$1-$3"
	_st=$(cat "$W/status" 2>/dev/null || echo missing)
	_vf=$(cat "$W/verify" 2>/dev/null || echo missing)
	_ef=$(cat "$W/effort_bound" 2>/dev/null || echo "n/a")
	_ok=yes
	[ "$_st" = complete ] || _ok=no
	# our arm must show the level BOUND; the other arm has no read-back and
	# is not failed for lacking one — it is recorded as unverified instead.
	if [ "$2" = kiso ] && [ "$_ef" != "$BENCH_EFFORT" ]; then _ok=no; fi
	say "  $2-$1-$3: status=$_st verify=$_vf effort=$_ef -> $( [ $_ok = yes ] && echo VALID || echo VOID )"
	[ "$_ok" = yes ]
}

VOID=0
for P in 1 2 3; do
	for T in T5 T6; do
		# ABBA within the pair-block: the arms alternate which goes first,
		# so a drift that runs one way through the afternoon does not always
		# land on the same arm.
		if [ $(( (P + $( [ "$T" = T5 ] && echo 0 || echo 1 ) ) % 2 )) -eq 0 ]; then
			ORDER="pi kiso"
		else
			ORDER="kiso pi"
		fi
		for TOOL in $ORDER; do
			say "$T pair $P — $TOOL"
			sh "$B/run-$(echo $T | tr 'A-Z' 'a-z').sh" "$TOOL" "r$P" || say "  the runner exited nonzero"
			check_leg "$T" "$TOOL" "r$P" || VOID=$((VOID + 1))
		done
	done
done

say "done — $VOID leg(s) failed a validity gate"
[ "$VOID" -eq 0 ] || say "A VOID LEG IS NOT A DATA POINT. Fix the instrument and re-run rather than scoring around it."
