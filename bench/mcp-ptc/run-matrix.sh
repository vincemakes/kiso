#!/bin/sh
# run-matrix.sh <cells> <arms> <rep-from> <rep-to> — run a block of legs one at
# a time: for every repetition and cell, every listed arm once, the arm order
# a pure function of the names (sha256 of "mcp-order-<cell>-<rep>-<arm>"),
# fixed before any leg runs. Each leg is run-leg.sh.
#
#   <cells>  comma list from cells.json            e.g. base,s120,host
#   <arms>   comma list of K-direct,P-direct,P-deferred,P-codemode
#
# Environment: MCP_ROUND_DIR (required), PI_BIN, KISO_BIN_PATH, KISO_VERSION
# (as run-leg.sh), MCP_REQ_CAP (default 400): no further leg starts once the
# ledger holds this many requests.
set -eu
CELLS=${1:?usage: run-matrix.sh <cells> <arms> <rep-from> <rep-to>}; ARMS=${2:?}; FROM=${3:?}; TO=${4:?}
B="$(cd "$(dirname "$0")" && pwd)"
: "${MCP_ROUND_DIR:?}"
MCP_REQ_CAP=${MCP_REQ_CAP:-400}
mkdir -p "$MCP_ROUND_DIR"
LEDGER="$MCP_ROUND_DIR/ledger.tsv"
[ -f "$LEDGER" ] || printf 'leg\tarm\tcell\trep\trequests\tcw\tverify\tstatus\tvoid\n' > "$LEDGER"
say() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$1"; }
total() { awk -F'\t' 'NR > 1 && $5 ~ /^[0-9]+$/ { s += $5 } END { print s + 0 }' "$LEDGER"; }
order() { # <cell> <rep> <arms...> -> arms, one per line, in the pre-registered order
	_c=$1; _r=$2; shift 2
	for _a in "$@"; do printf '%s %s\n' "$(printf 'mcp-order-%s-%s-%s' "$_c" "$_r" "$_a" | shasum -a 256 | cut -c1-16)" "$_a"; done | sort | cut -d' ' -f2
}
REP=$FROM
while [ "$REP" -le "$TO" ]; do
	for CELL in $(echo "$CELLS" | tr ',' ' '); do
		if [ "$(total)" -ge "$MCP_REQ_CAP" ]; then
			printf 'INCOMPLETE: %s requests before cell %s rep %s (cap %s)\n' "$(total)" "$CELL" "$REP" "$MCP_REQ_CAP" > "$MCP_ROUND_DIR/INCOMPLETE"
			say "request cap reached ($(total) of $MCP_REQ_CAP) - no further legs"; exit 0
		fi
		say "cell $CELL rep $REP"
		for ARM in $(order "$CELL" "$REP" $(echo "$ARMS" | tr ',' ' ')); do
			sh "$B/run-leg.sh" "$CELL" "$ARM" "r$REP" 2>&1 | grep -E "^LEG|NOT BARE|run-leg:" || true
			case "$ARM" in K-direct|K-program) F=kiso ;; *) F=pi ;; esac
			W="$MCP_ROUND_DIR/$F-$CELL-$ARM-r$REP"
			RQ=$(node -e 'try{process.stdout.write(String(require(process.argv[1]).requests))}catch{process.stdout.write("unknown")}' "$W/mcp-metrics.json")
			CW=$(node -e 'try{process.stdout.write(String(require(process.argv[1]).cw))}catch{process.stdout.write("unknown")}' "$W/mcp-metrics.json")
			printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$F-$CELL-$ARM-r$REP" "$ARM" "$CELL" "$REP" "$RQ" "$CW" "$(cat "$W/verify" 2>/dev/null || echo missing)" "$(cat "$W/status" 2>/dev/null || echo missing)" "$(head -1 "$W/void" 2>/dev/null || echo -)" >> "$LEDGER"
			say "  $ARM: requests=$RQ cw=$CW verify=$(cat "$W/verify" 2>/dev/null || echo missing)"
		done
	done
	REP=$((REP + 1))
done
say "reps $FROM..$TO done - $(total) requests"
