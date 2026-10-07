#!/bin/sh
# run-probe.sh <task> <legs> — an rc-only mechanism probe (eval-0460b's F1b;
# kiso-doc plan-0460-fix-b1-b2 §4).
#
# Not a paired set: the published control has no background delegation, so
# a pair would be asymmetric by construction. The probe measures the
# mechanism on the rc alone — background children, the idle wake, the group
# delivery — and its gates read the legs' own records (gates-0460b.mjs).
# Kept from run-paired.sh: a leg whose recorded version is not the rc's is
# VOID (reported, never rescored), and the round's SPEND CAP is read before
# each leg. Dropped: the cache-collapse rule, which needs a pair.
set -eu
TASK=${1:?usage: run-probe.sh <task> <legs>}
LEGS=${2:?usage: run-probe.sh <task> <legs>}
B="$(cd "$(dirname "$0")" && pwd)"
: "${KISO_BIN_RC:?set KISO_BIN_RC to the release candidate}"
: "${RC_VERSION:?set RC_VERSION}"
ROUND=${KISO_ROUND:-probe}
CAP=${BENCH_SPEND_CAP_USD:-5}
. "$B/leg-isolation.sh"
ROOT="$(runs_root "$B")/$ROUND"
mkdir -p "$ROOT"

VOID=0
STOPPED=""
# PROBE_FIRST (0.47.0 kit §7): a void probe leg is re-run under the NEXT run
# id, never its own — start the numbering there (`PROBE_FIRST=7 run-probe.sh W1 1`)
I=${PROBE_FIRST:-1}
LAST=$((I + LEGS - 1))
while [ "$I" -le "$LAST" ]; do
	_s=$(node "$B/round-spend.mjs" "$ROOT")
	if node -e 'process.exit(Number(process.argv[1]) > Number(process.argv[2]) ? 0 : 1)' "$_s" "$CAP"; then
		echo "SPEND CAP: \$$_s spent, cap \$$CAP — the probe stops here"
		STOPPED=cap
		break
	fi
	RUN="rc$I"
	echo "--- $TASK $RUN (rc)"
	KISO_ROUND="$ROUND" KISO_BIN="$KISO_BIN_RC" KISO_VERSION="" sh "$B/run-task.sh" "$TASK" "$RUN" || echo "    (runner exited non-zero; its status file is the record)"
	W="$ROOT/kiso-$TASK-$RUN"
	SAW=$(node -e 'try { console.log(String(JSON.parse(require("fs").readFileSync(process.argv[1] + "/meta.json", "utf8")).kisoVersion ?? "missing")); } catch { console.log("missing"); }' "$W" 2>/dev/null || echo missing)
	# EXACT (0.47.0 kit §2)
	if [ "$SAW" != "$RC_VERSION" ]; then
		printf 'VOID: its meta records %s (wanted exactly %s)\n' "$SAW" "$RC_VERSION" > "$W/void"
		echo "    VOID — wanted exactly $RC_VERSION, the leg records $SAW"; VOID=$((VOID + 1))
	fi
	I=$((I + 1))
done
echo
echo "$TASK: legs $LEGS   void legs (version): $VOID${STOPPED:+   STOPPED: $STOPPED}   spent: \$$(node "$B/round-spend.mjs" "$ROOT")"
[ "$VOID" -eq 0 ] || echo "A VOID LEG IS NOT A DATA POINT. Fix the wiring and re-run rather than scoring around one."
