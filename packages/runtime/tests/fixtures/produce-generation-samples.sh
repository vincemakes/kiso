#!/bin/sh
# Produce the generation samples (ADR-0051 §3, ruling R4a): every sample
# is a REAL log written by a REAL published bin — never hand-synthesized.
#
#   ./produce-generation-samples.sh [bin ...]   (default: 0.1.42 0.1.46 0.1.48)
#
# Each run: a fresh KISO_HOME, the product's own faux mode
# (KISO_FAUX_SCRIPT), one piped prompt, and the session file copied to
# ./sessions/gen-<generation>-<bin>-faux.jsonl with a provenance row in
# ./sessions/PROVENANCE.md. The microcompact marker variant is produced
# with KISO_CONTEXT_WINDOW=16000 and the heavy script (the product's own
# override; the threshold becomes 8000 tokens, crossed mid-script).
set -u
# The [bin ...] filter the usage line promises: with args, only those
# versions produce (re-producing an already-registered sample would
# change a frozen fixture — the registry rows pin their produced dates).
ONLY="$*"
want() {
	[ -z "$ONLY" ] && return 0
	case " $ONLY " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
FAUX="$HERE/faux.json"
HEAVY="$HERE/faux-heavy.json"
WORK="$(mktemp -d /tmp/kiso-samples.XXXXXX)"

produce() { # $1=bin $2=session-id $3=script $4=output-name (in ./sessions/)
	VER=$1; SID=$2; SCRIPT=$3; OUT=$4
	HOME_DIR="$WORK/home-$VER-$SID"
	mkdir -p "$HOME_DIR/sessions" "$HOME_DIR/ext"
	cd "$REPO" || exit 1
	export KISO_HOME="$HOME_DIR"
	export KISO_FAUX_SCRIPT="$SCRIPT"
	export KISO_EXTENSIONS_DIR="$HOME_DIR/ext"
	export KISO_MCP_CONFIG="$HOME_DIR/mcp.json"
	# The marker variant needs the product's own context-window override
	# (threshold = half the window → 8000 tokens, crossed mid-script).
	if [ "$SCRIPT" = "$HEAVY" ]; then export KISO_CONTEXT_WINDOW=16000; else unset KISO_CONTEXT_WINDOW; fi
	echo '{}' > "$HOME_DIR/mcp.json"
	printf 'Survey the repository structure.\n' |
		npx -y "@vincemakes/kiso-code@$VER" "$SID" > /dev/null 2>&1
	F=$(ls "$HOME_DIR/sessions/"*.jsonl 2>/dev/null | head -1)
	if [ -z "$F" ]; then
		echo "NO SESSION for $VER (see the npx output; the bin may lack faux mode)" >&2
		return 1
	fi
	cp "$F" "$HERE/sessions/$OUT"
	echo "produced $OUT ($(wc -l < "$F") records)"
}

want "0.1.42" && produce "0.1.42" "fxgen0.1.42" "$FAUX" "gen-d-0142-faux.jsonl"
want "0.1.46" && produce "0.1.46" "fxgen0.1.46" "$FAUX" "gen-e-0146-faux.jsonl"
want "0.1.48" && produce "0.1.48" "fxgen0.1.48" "$FAUX" "gen-f-0148-faux.jsonl"
# EC-1: the last PRE-EC-1 producer (0.13.0 moves asks behind Turn Commit,
# so no later bin writes a request with no stop before it).
want "0.12.0" && produce "0.12.0" "fxgen0.12.0" "$FAUX" "gen-f-0120-faux.jsonl"
# The FIRST EC-1 producer (gen F on the wire; the era boundary's far side).
want "0.13.0" && produce "0.13.0" "fxgen0.13.0" "$FAUX" "gen-f-0130-faux.jsonl"
# The marker-bearing variant (KISO_CONTEXT_WINDOW override, heavy script):
want "0.1.46" && produce "0.1.46" "m46" "$HEAVY" "gen-e-0146-marker.jsonl"
want "0.1.48" && produce "0.1.48" "m48" "$HEAVY" "gen-f-0148-marker.jsonl"
want "0.12.0" && produce "0.12.0" "m0120" "$HEAVY" "gen-f-0120-marker.jsonl"
want "0.13.0" && produce "0.13.0" "m0130" "$HEAVY" "gen-f-0130-marker.jsonl"
rm -rf "$WORK"
echo "done — update ./sessions/PROVENANCE.md rows with the produced dates"
