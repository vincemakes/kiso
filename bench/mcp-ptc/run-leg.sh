#!/bin/sh
# run-leg.sh <cell> <arm> <run> — ONE leg of the MCP programmatic-tool-calling
# benchmark: a cell of cells.json run by one arm, through the existing
# run-t6.sh leg (bare home, per-leg deadline and request ceiling, capture
# proxy), fed one generated instance through BENCH_INSTANCE and one MCP overlay
# through BENCH_OVERLAY.
#
#   arm: K-direct | P-direct | P-deferred | P-codemode
#
# Environment:
#   MCP_ROUND_DIR   where legs and their snapshots live (required)
#   PI_BIN          the reference implementation binary   (P-* arms)
#   KISO_BIN_PATH   the kiso binary                       (K-direct)
#   KISO_VERSION    its version                           (K-direct)
#
# The runner's own instance verdict reads `error` (it belongs to another set);
# this script overwrites `verify` with verify.mjs's, which reads the SERVER'S
# end-state snapshot, and writes cm-metrics.json beside it.
set -eu
CELL=${1:?usage: run-leg.sh <cell> <arm> <run>}; ARM=${2:?}; RUN=${3:?}
B="$(cd "$(dirname "$0")/.." && pwd)"; M="$B/mcp-ptc"
: "${MCP_ROUND_DIR:?}"
mkdir -p "$MCP_ROUND_DIR"
CFG=$(node -e 'const c=require(process.argv[1])[process.argv[2]];if(!c){process.exit(3)}console.log(c.tools+" "+c.volume+" "+c.task)' "$M/cells.json" "$CELL" 2>/dev/null) || { echo "unknown cell $CELL" >&2; exit 3; }
set -- $CFG; TOOLS=$1; VOLUME=$2; TASK=$3
case "$ARM" in K-direct|K-program) FAMILY=kiso ;; P-direct|P-deferred|P-codemode|P-codemode-only) FAMILY=pi ;; *) echo "unknown arm $ARM" >&2; exit 3 ;; esac
LEG="$ARM-$CELL-$RUN"
INST="$MCP_ROUND_DIR/inst-$CELL"
if [ ! -d "$INST" ]; then
	mkdir -p "$INST/fixture"
	printf '# workspace\n\nA scratch directory. The task is done through the tools you were given.\n' > "$INST/fixture/README.md"
	node -e 'const t=require(process.argv[1])[process.argv[2]];require("fs").writeFileSync(process.argv[3]+"/tasks.json",JSON.stringify([t.prompt]));require("fs").writeFileSync(process.argv[3]+"/instance.json",JSON.stringify({id:process.argv[4]}))' "$M/tasks.json" "$TASK" "$INST" "$CELL"
fi
SNAP="$MCP_ROUND_DIR/snap-$LEG.json"; OVERLAY="$MCP_ROUND_DIR/overlay-$LEG"
rm -f "$SNAP"; rm -rf "$OVERLAY"
node "$M/leg-config.mjs" "$ARM" "$TOOLS" "$VOLUME" "$OVERLAY" "$SNAP"

export KISO_RUNS_ROOT="$MCP_ROUND_DIR" KISO_ROUND="" BENCH_ROUTE=${BENCH_ROUTE:-co} BENCH_EFFORT=${BENCH_EFFORT:-none} BENCH_CAPTURE=1
export KISO_LEG_DEADLINE_S=${KISO_LEG_DEADLINE_S:-900} KISO_LEG_MAX_REQUESTS=${KISO_LEG_MAX_REQUESTS:-150}
export BENCH_INSTANCE="$INST" BENCH_INSTANCE_ID="$CELL" BENCH_INSTANCE_SEED=mcp BENCH_OVERLAY="$OVERLAY"
if [ "$FAMILY" = pi ]; then
	: "${PI_BIN:?}"
	REFB="$PI_BIN"
	if [ "$ARM" = P-codemode-only ]; then # the same reference runtime with ONLY the script tool (no shell, no file tools): a domain host's shape
		REFB="$MCP_ROUND_DIR/shims/pi-codemode-only"; mkdir -p "$MCP_ROUND_DIR/shims"
		printf '#!/bin/sh\nexec "%s" --tools codemode "$@"\n' "$PI_BIN" > "$REFB"; chmod +x "$REFB"
	fi
	REF_BIN="$REFB" sh "$B/run-t6.sh" pi "$ARM-$RUN" || echo "run-leg: the runner exited non-zero; the leg's own files are the record" >&2
	W="$MCP_ROUND_DIR/pi-$CELL-$ARM-$RUN"
else
	: "${KISO_BIN_PATH:?}" "${KISO_VERSION:?}"
	KB="$KISO_BIN_PATH"; KV="$KISO_VERSION"; CAP=${BENCH_CAPTURE}
	if [ "$ARM" = K-program ]; then KB="node $B/program/host.mjs"; KV=0.48.0-program; CAP=0; fi # kiso as a library, the program tool only
	BENCH_CAPTURE=$CAP KISO_BIN="$KB" KISO_VERSION="$KV" sh "$B/run-t6.sh" kiso "$ARM-$RUN" || echo "run-leg: the runner exited non-zero; the leg's own files are the record" >&2
	W="$MCP_ROUND_DIR/kiso-$CELL-$ARM-$RUN"
fi
V=$(node "$M/verify.mjs" "$TASK" "$SNAP" "$W/answer.txt" 2> "$W/verify.detail.json") || V=error
printf '%s\n' "$V" > "$W/verify"
node "$M/extract.mjs" "$W" "$SNAP" > "$W/mcp-metrics.json" 2> "$W/extract.err" || echo '{}' > "$W/mcp-metrics.json"
echo "LEG $W verify=$V"
