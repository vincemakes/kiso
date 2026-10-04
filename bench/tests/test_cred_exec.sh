#!/bin/sh
# The key never enters any argv (the owner's rule): cred-exec.sh reads it
# inside the process that becomes the arm; the runners hand over a PATH.
# Proved end to end: an arm that snapshots the WHOLE process table while it
# runs must not find the key in anyone's arguments. Free: a fake key.
set -eu
B="$(cd "$(dirname "$0")/.." && pwd)"
P=0; F=0
ok()   { printf "  ok   %s\n" "$1"; P=$((P+1)); }
bad()  { printf "  FAIL %s\n" "$1"; F=$((F+1)); }
T=$(cd "$(mktemp -d)" && pwd -P)
KEY="sk-cred-exec-test-$(date +%s)-canary"
mkdir -p "$T/cfg/claude-deepseek"
printf 'DEEPSEEK_API_KEY=%s\nexport OTHER_SECRET=must-not-leak\n' "$KEY" > "$T/cfg/claude-deepseek/credentials.env"
CRED="$T/cfg/claude-deepseek/credentials.env"

# 1. the mapping: the arm reads the key under the name it expects, and
#    nothing else the file defines reaches it
out=$(env -i PATH="$PATH" BENCH_CRED_FILE="$CRED" BENCH_CRED_AS=OPENAI_API_KEY sh "$B/cred-exec.sh" sh -c 'printf "%s|%s|%s|%s" "${OPENAI_API_KEY:-}" "${DEEPSEEK_API_KEY:-}" "${OTHER_SECRET:-}" "${BENCH_CRED_FILE:-}"')
[ "$out" = "$KEY|||" ] && ok "the arm reads the key as OPENAI_API_KEY; nothing else from the file, and no path, reaches it" || bad "mapping: $out"

# 2. a file without the key refuses to launch the arm
# 3f: a route names the variable INSIDE the file (BENCH_CRED_KEY) — the
# Command Code file carries COMMANDCODE_API_KEY, not DEEPSEEK_API_KEY
printf 'COMMANDCODE_API_KEY=%s\nDEEPSEEK_API_KEY=not-this-one\n' "$KEY" > "$T/co.env"
out=$(env -i PATH="$PATH" BENCH_CRED_FILE="$T/co.env" BENCH_CRED_AS=OPENAI_API_KEY BENCH_CRED_KEY=COMMANDCODE_API_KEY sh "$B/cred-exec.sh" sh -c 'printf "%s|%s" "${OPENAI_API_KEY:-}" "${BENCH_CRED_KEY:-}"')
[ "$out" = "$KEY|" ] && ok "BENCH_CRED_KEY picks the variable inside the file, and is not passed on" || bad "named key: $out"
if env -i PATH="$PATH" BENCH_CRED_FILE="$T/co.env" BENCH_CRED_AS=OPENAI_API_KEY BENCH_CRED_KEY='X;rm' sh "$B/cred-exec.sh" true 2>/dev/null; then bad "a non-name BENCH_CRED_KEY launched the arm"; else ok "a BENCH_CRED_KEY that is not a variable name refuses to launch"; fi

printf 'NOTHING=1\n' > "$T/empty.env"
if env -i PATH="$PATH" BENCH_CRED_FILE="$T/empty.env" BENCH_CRED_AS=OPENAI_API_KEY sh "$B/cred-exec.sh" true 2>/dev/null; then bad "a keyless file launched the arm"; else ok "a file without the key refuses to launch the arm"; fi

# 3. END TO END through both runners: the fake arm snapshots every process's
#    arguments while it is running; the key must appear in none of them
mkdir -p "$T/bin"
# THE WINDOW THE OLD RUNNERS LEFT OPEN was `env -i ... OPENAI_API_KEY=<key>`:
# that argv lives only until env execs the arm, so a snapshot taken BY the
# arm can never see it. A shim records every `env` invocation's arguments.
REAL_ENV=$(command -v env)
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s/env-args.txt"\nexec "%s" "$@"\n' "$T" "$REAL_ENV" > "$T/bin/env"
chmod +x "$T/bin/env"
for t in kiso pi; do
	cat > "$T/bin/$t" <<EOF
case "\$1" in --version) echo 9.9.9; exit 0 ;; esac
ps -A -o args= >> "$T/ps-\$\$.txt" 2>/dev/null || true
cat > /dev/null 2>&1 || true
exit 0
EOF
	chmod +x "$T/bin/$t"
done
for runner in run-t5.sh run-t6.sh; do
	for tool in kiso pi; do
		PATH="$T/bin:$PATH" XDG_CONFIG_HOME="$T/cfg" KISO_BIN=kiso KISO_VERSION=9.9.9 KISO_RUNS_ROOT="$T/runs" KISO_ROUND=cred KISO_LEG_MAX_REQUESTS=2 \
			sh "$B/$runner" "$tool" c1 > /dev/null 2>&1 || true
	done
done
snaps=$(ls "$T"/ps-*.txt 2>/dev/null | wc -l | tr -d ' ')
[ "$snaps" -ge 4 ] && ok "the fake arms ran and snapshotted the process table ($snaps snapshots)" || bad "only $snaps snapshots — the arms did not run"
if cat "$T"/ps-*.txt 2>/dev/null | grep -q "$KEY"; then bad "THE KEY APPEARED IN A PROCESS'S ARGUMENTS"; else ok "the key appears in no process's arguments, through either runner, for either arm"; fi
calls=$(wc -l < "$T/env-args.txt" 2>/dev/null | tr -d ' ' || echo 0)
[ "${calls:-0}" -ge 4 ] && ok "every arm launch went through env -i ($calls recorded)" || bad "env -i was not seen ($calls calls)"
if grep -q "$KEY" "$T/env-args.txt" 2>/dev/null; then bad "THE KEY WAS AN ARGUMENT TO env -i"; else ok "the key is never an argument to env -i; the launch carries the file PATH instead"; fi
grep -q "BENCH_CRED_FILE=$CRED" "$T/env-args.txt" && ok "what env -i receives is BENCH_CRED_FILE, the path" || bad "no BENCH_CRED_FILE in the launch arguments"

echo "[cred-exec] $P ok, $F failed"
[ "$F" -eq 0 ]
