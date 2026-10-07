#!/bin/sh
# run-launch.sh <part: t5 | t6 | concealed> <from> <to>
#
# The small launch bench's block driver (kit: kits/launch-small.md, frozen
# before the first scored leg): kiso against the reference implementation,
# both bare, in INTERLEAVED PAIRS — odd pairs run kiso first, even pairs
# the other arm first, so drift inside a pair never loads onto one arm.
#
#   t5 | t6     pairs <from>..<to> of that series (run ids p<N>)
#   concealed   positions <from>..<to> of LAUNCH_INSTANCES, the schedule's
#               instance ids (family F is never scheduled — the lead's
#               ruling: non-comparable at launch). LAUNCH_SEED is the seed
#               the owner drew; it is read from the environment and never
#               written into the tree.
#
# Every leg runs with its legs under LAUNCH_ROOT (outside any checkout —
# the runners' isolation gates void a leg beneath an instruction file),
# BENCH_CAPTURE=1 (both arms' request bodies; the effort is read back from
# the wire) and BENCH_EFFORT (high unless the kit says otherwise). After every leg the driver asks the leg
# what it ran (check_leg); a leg that cannot say is VOID — reported in the
# ledger, never rescored.
#
# A CONCEALED INSTANCE IS STAGED, never materialized beside a leg: the pair
# gets fixture/ and tasks.json in a staging directory, and the runner
# materializes the verifier from the seed only after each arm has exited
# (run-t6.sh, THE ANSWER IS NEVER ON DISK WHILE AN ARM RUNS).
#
# THE PART CAP: the requests of this part's legs are summed from each leg's
# own ledger; before a pair starts, a total at or over LAUNCH_PART_CAP
# stops the part and writes INCOMPLETE — no comparative verdict for it.
# Legs already run stay on disk and are archived either way.
set -eu
PART=${1:?usage: run-launch.sh <t5|t6|concealed> <from> <to>}
FROM=${2:?usage: run-launch.sh <part> <from> <to>}
TO=${3:?usage: run-launch.sh <part> <from> <to>}
B="$(cd "$(dirname "$0")" && pwd)"
: "${KISO_BIN:?set KISO_BIN to the packed install of the artifact under test}"
: "${LAUNCH_ROUND:?set LAUNCH_ROUND to the round name}"
: "${LAUNCH_PART_CAP:?set LAUNCH_PART_CAP to the request cap of this part}"
# the runs root is named `runs` so the extractors (which read <dir>/runs)
# take its parent as their working directory
LAUNCH_ROOT=${LAUNCH_ROOT:-/private/tmp/kiso-launch-bench/runs}
KISO_RUNS_ROOT="$LAUNCH_ROOT"; KISO_ROUND="$LAUNCH_ROUND-$PART"
# the effort is the kit's: high by default (the launch); `none` is the
# provider's default on a route where the switch cannot bind (route.sh),
# verified on the wire as the absence of any effort field
BENCH_CAPTURE=1; BENCH_EFFORT=${BENCH_EFFORT:-high}
export KISO_RUNS_ROOT KISO_ROUND BENCH_CAPTURE BENCH_EFFORT KISO_BIN
PARTDIR="$LAUNCH_ROOT/$KISO_ROUND"
mkdir -p "$PARTDIR"
. "$B/leg-limits.sh"
LEDGER="$PARTDIR/ledger.tsv"
[ -f "$LEDGER" ] || printf 'leg\ttool\trequests\tstatus\tverify\teffort_wire\tvoid\textra_calls\n' > "$LEDGER"

say() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$1"; }

case "$PART" in
	t5) RUNNER="$B/run-t5.sh"; TASK=T5 ;;
	t6|concealed) RUNNER="$B/run-t6.sh"; TASK=T6 ;;
	*) echo "run-launch.sh: unknown part $PART" >&2; exit 2 ;;
esac
if [ "$PART" = concealed ]; then
	: "${LAUNCH_INSTANCES:?set LAUNCH_INSTANCES to the scheduled instance ids}"
	: "${LAUNCH_SEED:?set LAUNCH_SEED to the drawn seed}"
fi

part_requests() { awk -F'\t' 'NR > 1 && $3 ~ /^[0-9]+$/ { s += $3 } END { print s + 0 }' "$LEDGER"; }

# The arm a leg ACTUALLY ran as, from its own captured bodies: ours dumps
# them itself (req-<pid>-<seq>.json), the other arm's go through the proxy
# (req-<n>.json). Launched as one and recorded as the other is VOID.
arm_of() {
	_c="$1/capture"
	if ls "$_c"/req-*-*.json >/dev/null 2>&1; then echo kiso
	elif ls "$_c"/req-[0-9]*.json >/dev/null 2>&1; then echo pi
	else echo none; fi
}

# check_leg <tool> <work>: one ledger row; the reasons a leg is VOID.
check_leg() {
	_t=$1; _w=$2
	_st=$(cat "$_w/status" 2>/dev/null || echo missing)
	_vf=$(cat "$_w/verify" 2>/dev/null || echo missing)
	_ew=$(cat "$_w/effort_wire" 2>/dev/null || echo missing)
	_rq=$(requests_so_far "$_w" "$_t" 2>/dev/null || echo unknown)
	if [ ! -s "$_w/void" ]; then
		_why=""
		[ "$_ew" = "$BENCH_EFFORT" ] || _why="the wire shows effort '$_ew', not $BENCH_EFFORT"
		if [ -z "$_why" ]; then
			# MORE bodies than recorded requests is a retry or a failed call the
			# arm never billed — real traffic, REPORTED (extra_calls), never a
			# reason to void. FEWER bodies, another model, or a missing effort
			# means the leg cannot say what it ran: VOID.
			_ok=$(node -e '
				let r; try { r = require(process.argv[1]); } catch { process.stdout.write("no capture record"); process.exit(0); }
				const rest = (r.problems || []).filter((p) => {
					const m = /^captured (\d+) model calls, the leg recorded (\d+) requests$/.exec(p);
					return !(m && Number(m[1]) > Number(m[2]));
				});
				process.stdout.write(rest.length === 0 ? "ok" : rest.join("; "));
			' "$_w/capture.json" 2>/dev/null || echo "unreadable")
			[ "$_ok" = ok ] || _why="its capture does not reconcile: $_ok"
		fi
		if [ -z "$_why" ]; then
			_arm=$(arm_of "$_w")
			[ "$_arm" = "$_t" ] || _why="launched as $_t, its bodies were written by $_arm"
		fi
		[ -z "$_why" ] || printf 'VOID: %s\n' "$_why" > "$_w/void"
	fi
	_vd=$(cat "$_w/void" 2>/dev/null | head -1 || true)
	_xc=$(node -e 'try { const r = require(process.argv[1]); const m = (r.problems || []).map((p) => /^captured (\d+) model calls, the leg recorded (\d+) requests$/.exec(p)).find(Boolean); process.stdout.write(m && Number(m[1]) > Number(m[2]) ? String(Number(m[1]) - Number(m[2])) : "0"); } catch { process.stdout.write("unknown"); }' "$_w/capture.json" 2>/dev/null || echo unknown)
	printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(basename "$_w")" "$_t" "$_rq" "$_st" "$_vf" "$_ew" "${_vd:--}" "$_xc" >> "$LEDGER"
	say "  $(basename "$_w"): status=$_st verify=$_vf effort_wire=$_ew requests=$_rq ${_vd:+· $_vd}"
}

# stage <id>: fixture/ and tasks.json only, in a directory of its own
stage() {
	_s=$(mktemp -d); _h=$(mktemp -d)
	node "$B/concealed/cli.mjs" materialize --seed "$LAUNCH_SEED" --instance "$1" --out "$_h/i" > /dev/null
	cp -R "$_h/i/fixture" "$_s/fixture"; cp "$_h/i/tasks.json" "$_s/tasks.json"
	rm -rf "$_h"
	echo "$_s"
}

I=$FROM
while [ "$I" -le "$TO" ]; do
	TOTAL=$(part_requests)
	if [ "$TOTAL" -ge "$LAUNCH_PART_CAP" ]; then
		printf 'INCOMPLETE: the part reached %s requests before pair %s (cap %s)\n' "$TOTAL" "$I" "$LAUNCH_PART_CAP" > "$PARTDIR/INCOMPLETE"
		say "cap reached ($TOTAL of $LAUNCH_PART_CAP) — the part is INCOMPLETE; no comparative verdict"
		exit 0
	fi
	if [ $((I % 2)) -eq 1 ]; then ORDER="kiso pi"; else ORDER="pi kiso"; fi
	if [ "$PART" = concealed ]; then
		ID=$(printf '%s\n' $LAUNCH_INSTANCES | sed -n "${I}p")
		[ -n "$ID" ] || { say "no instance at position $I"; break; }
		case "$ID" in F-*) say "F is never scheduled at launch (non-comparable) — $ID skipped"; I=$((I + 1)); continue ;; esac
		STAGE=$(stage "$ID")
		say "pair $I — $ID ($ORDER)"
		for TOOL in $ORDER; do
			BENCH_INSTANCE="$STAGE" BENCH_INSTANCE_ID="$ID" BENCH_INSTANCE_SEED="$LAUNCH_SEED" \
				sh "$RUNNER" "$TOOL" "p$I" || say "  the runner exited non-zero; the leg's own files are the record"
			check_leg "$TOOL" "$PARTDIR/$TOOL-$ID-p$I"
		done
		rm -rf "$STAGE"
	else
		say "pair $I — $TASK ($ORDER)"
		for TOOL in $ORDER; do
			sh "$RUNNER" "$TOOL" "p$I" || say "  the runner exited non-zero; the leg's own files are the record"
			check_leg "$TOOL" "$PARTDIR/$TOOL-$TASK-p$I"
		done
	fi
	I=$((I + 1))
done
say "part $PART pairs $FROM..$TO done · $(part_requests) requests · void legs: $(awk -F'\t' 'NR > 1 && $7 != "-"' "$LEDGER" | wc -l | tr -d ' ')"
