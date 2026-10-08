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

# 4. THE OWNER'S ROUTE (2026-10-07): Command Code, for BOTH comparable arms.
#    The reference arm takes its key from a COMMAND in its model store
#    (route.sh, cred-print.sh), so the key must be in neither its
#    environment, nor any argv, nor any file inside the leg; and the store,
#    resolved the way the arm resolves it, must yield exactly the key.
mkdir -p "$T/cfg/kiso-commandcode" "$T/cobin"
printf 'COMMANDCODE_API_KEY=%s\nexport OTHER_SECRET=must-not-leak\n' "$KEY" > "$T/cfg/kiso-commandcode/credentials.env"
out=$(sh "$B/cred-print.sh" "$T/cfg/kiso-commandcode/credentials.env" COMMANDCODE_API_KEY)
[ "$out" = "$KEY" ] && ok "cred-print prints the named variable's value and nothing else" || bad "cred-print printed: $out"
err=$(sh "$B/cred-print.sh" "$T/empty.env" COMMANDCODE_API_KEY 2>&1 >/dev/null || echo "rc=$?")
case "$err" in *rc=78*) ok "cred-print refuses a file without the variable (78)" ;; *) bad "cred-print on a keyless file: $err" ;; esac
if sh "$B/cred-print.sh" "$T/cfg/kiso-commandcode/credentials.env" 'X;rm' >/dev/null 2>&1; then bad "cred-print accepted a non-name"; else ok "cred-print refuses a variable that is not a name"; fi
for t in kiso pi; do
	cat > "$T/cobin/$t" <<EOF
case "\$1" in --version) echo 9.9.9; exit 0 ;; esac
env > "$T/co-env-$t-\$\$.txt"
printf '%s\n' "\$*" > "$T/co-argv-$t-\$\$.txt"
ps -A -o args= >> "$T/co-ps-\$\$.txt" 2>/dev/null || true
if [ "$t" = pi ]; then
	node -e 'const fs=require("fs"),cp=require("child_process");const s=JSON.parse(fs.readFileSync(process.env.HOME+"/.pi/agent/models.json","utf8"));const k=s.providers.route.apiKey;fs.writeFileSync(process.argv[1],k.startsWith("!")?cp.execSync(k.slice(1)).toString():"literal:"+k)' "$T/co-key-\$\$.txt"
fi
cat > /dev/null 2>&1 || true
exit 0
EOF
	chmod +x "$T/cobin/$t"
done
for runner in run-t5.sh run-t6.sh; do
	for tool in kiso pi; do
		PATH="$T/cobin:$PATH" XDG_CONFIG_HOME="$T/cfg" BENCH_ROUTE=co BENCH_EFFORT=none REF_BIN=pi KISO_BIN=kiso KISO_VERSION=9.9.9 \
			KISO_RUNS_ROOT="$T/co-runs" KISO_ROUND=co KISO_LEG_MAX_REQUESTS=2 sh "$B/$runner" "$tool" k1 > /dev/null 2>&1 || true
	done
done
n=$(ls "$T"/co-key-*.txt 2>/dev/null | wc -l | tr -d ' ')
[ "$n" -ge 2 ] && ok "the reference arm ran through both runners on the route ($n turns)" || bad "the reference arm did not run on the route ($n turns)"
wrong=0; for f in "$T"/co-key-*.txt; do [ "$(cat "$f")" = "$KEY" ] || wrong=$((wrong + 1)); done
if [ "$n" -ge 1 ] && [ "$wrong" -eq 0 ]; then ok "its model store resolves, the way the arm resolves it, to exactly the key (every turn)"; else bad "$wrong of $n turns resolved the store to something other than the key"; fi
if cat "$T"/co-env-pi-*.txt 2>/dev/null | grep -q "$KEY"; then bad "THE KEY IS IN THE REFERENCE ARM'S ENVIRONMENT (LB-2)"; else ok "the key is not in the reference arm's environment, so its shell tool cannot inherit it"; fi
if cat "$T"/co-ps-*.txt 2>/dev/null | grep -q "$KEY"; then bad "THE KEY APPEARED IN A PROCESS'S ARGUMENTS on the route"; else ok "the key appears in no process's arguments on the route"; fi
if grep -rq "$KEY" "$T/co-runs" 2>/dev/null; then bad "THE KEY IS IN A FILE INSIDE A LEG"; else ok "no file inside any leg carries the key"; fi
grep -h -- "--provider route --model deepseek/deepseek-v4.1-flash --thinking off" "$T"/co-argv-pi-*.txt >/dev/null 2>&1 && ok "the reference arm binds the route's model with thinking off (the provider's default)" || bad "reference argv: $(head -1 "$T"/co-argv-pi-*.txt 2>/dev/null)"
grep -h "^OPENAI_BASE_URL=https://api.commandcode.ai/provider/v1$" "$T"/co-env-kiso-*.txt >/dev/null 2>&1 && ok "the kiso arm takes the route's endpoint through both runners" || bad "kiso arm endpoint: $(grep -h OPENAI_BASE_URL "$T"/co-env-kiso-*.txt 2>/dev/null | sort -u)"
[ "$(grep -h "^OPENAI_API_KEY=" "$T"/co-env-kiso-*.txt 2>/dev/null | sort -u)" = "OPENAI_API_KEY=$KEY" ] && ok "the kiso arm reads the route's key (COMMANDCODE_API_KEY) as OPENAI_API_KEY" || bad "kiso arm key mapping"
k6=$(ls "$T"/co-env-kiso-*.txt 2>/dev/null | wc -l | tr -d ' ')
[ "$k6" -ge 2 ] && ok "the kiso arm ran on the route through run-t5.sh and run-t6.sh ($k6 processes)" || bad "kiso arm on the route: $k6 processes"
if PATH="$T/cobin:$PATH" XDG_CONFIG_HOME="$T/cfg" BENCH_ROUTE=co KISO_RUNS_ROOT="$T/co-runs" KISO_ROUND=co sh "$B/run-t5.sh" claude k2 > /dev/null 2>&1; then bad "the third arm ran on the route"; else ok "the third arm refuses the route (the official endpoint only)"; fi

# 5. THE OP ROUTE (2026-10-08): OpenCode Go, whose gateway refuses a request
#    without a per-session `x-opencode-session` header and caches by it.
#    The kiso arm's profile carries the header as {session} and is bound by
#    --model (the env binding cannot carry a header); the reference arm's
#    store names one header value per leg. The key rules of block 4 hold.
mkdir -p "$T/cfg/kiso-opencode" "$T/opbin"
printf 'OPENCODE_API_KEY=%s\nexport OTHER_SECRET=must-not-leak\n' "$KEY" > "$T/cfg/kiso-opencode/credentials.env"
for t in kiso pi; do
	cat > "$T/opbin/$t" <<EOF
case "\$1" in --version) echo 9.9.9; exit 0 ;; esac
env > "$T/op-env-$t-\$\$.txt"
printf '%s\n' "\$*" > "$T/op-argv-$t-\$\$.txt"
ps -A -o args= >> "$T/op-ps-\$\$.txt" 2>/dev/null || true
if [ "$t" = pi ]; then
	cp "\$HOME/.pi/agent/models.json" "$T/op-store-\$\$.json"
	node -e 'const fs=require("fs"),cp=require("child_process");const s=JSON.parse(fs.readFileSync(process.env.HOME+"/.pi/agent/models.json","utf8"));const k=s.providers.route.apiKey;fs.writeFileSync(process.argv[1],k.startsWith("!")?cp.execSync(k.slice(1)).toString():"literal:"+k)' "$T/op-key-\$\$.txt"
else
	cp "\$KISO_HOME/config.json" "$T/op-profile-\$\$.json"
fi
cat > /dev/null 2>&1 || true
exit 0
EOF
	chmod +x "$T/opbin/$t"
done
for runner in run-t5.sh run-t6.sh; do
	for tool in kiso pi; do
		PATH="$T/opbin:$PATH" XDG_CONFIG_HOME="$T/cfg" BENCH_ROUTE=op BENCH_EFFORT=none REF_BIN=pi KISO_BIN=kiso KISO_VERSION=9.9.9 \
			KISO_RUNS_ROOT="$T/op-runs" KISO_ROUND=op KISO_LEG_MAX_REQUESTS=2 sh "$B/$runner" "$tool" k1 > /dev/null 2>&1 || true
	done
done
n=$(ls "$T"/op-key-*.txt 2>/dev/null | wc -l | tr -d ' ')
wrong=0; for f in "$T"/op-key-*.txt; do [ "$(cat "$f")" = "$KEY" ] || wrong=$((wrong + 1)); done
if [ "$n" -ge 2 ] && [ "$wrong" -eq 0 ]; then ok "op: the reference arm ran through both runners and its store resolves to exactly the key ($n turns)"; else bad "op: reference store: $wrong of $n turns wrong"; fi
hdrs=$(for f in "$T"/op-store-*.json; do node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((s.providers.route.headers||{})["x-opencode-session"]||"NONE")' "$f"; echo; done | sort -u)
case "$hdrs" in *NONE*|"") bad "op: a reference store without the session header: $hdrs" ;; *) ok "op: every reference store names the session header" ;; esac
[ "$(printf '%s\n' "$hdrs" | wc -l | tr -d ' ')" -ge 2 ] && ok "op: each reference leg has its own session value (one per leg, not one per round)" || bad "op: reference legs share a session value: $hdrs"
prof=$(for f in "$T"/op-profile-*.json; do node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).models.ds;process.stdout.write(s.baseUrl+"|"+s.model+"|"+JSON.stringify(s.headers))' "$f"; echo; done | sort -u)
[ "$prof" = 'https://opencode.ai/zen/go/v1|deepseek-v4.1-flash|{"x-opencode-session":"{session}"}' ] && ok "op: the kiso arm's profile names the gateway, the model and the header as {session}" || bad "op: kiso profile: $prof"
k=$(ls "$T"/op-argv-kiso-*.txt 2>/dev/null | wc -l | tr -d ' ')
m=$(grep -l -- "--model ds" "$T"/op-argv-kiso-*.txt 2>/dev/null | wc -l | tr -d ' ')
[ "$k" -ge 2 ] && [ "$m" -eq "$k" ] && ok "op: every kiso launch binds the profile with --model ds ($m of $k)" || bad "op: --model ds on $m of $k kiso launches"
[ "$(grep -h "^OPENAI_API_KEY=" "$T"/op-env-kiso-*.txt 2>/dev/null | sort -u)" = "OPENAI_API_KEY=$KEY" ] && ok "op: the kiso arm reads OPENCODE_API_KEY as OPENAI_API_KEY" || bad "op: kiso arm key mapping"
if cat "$T"/op-env-pi-*.txt 2>/dev/null | grep -q "$KEY"; then bad "op: THE KEY IS IN THE REFERENCE ARM'S ENVIRONMENT"; else ok "op: the key is not in the reference arm's environment"; fi
if cat "$T"/op-ps-*.txt 2>/dev/null | grep -q "$KEY"; then bad "op: THE KEY APPEARED IN A PROCESS'S ARGUMENTS"; else ok "op: the key appears in no process's arguments"; fi
if grep -rq "$KEY" "$T/op-runs" 2>/dev/null; then bad "op: THE KEY IS IN A FILE INSIDE A LEG"; else ok "op: no file inside any leg carries the key"; fi
grep -h -- "--provider route --model deepseek-v4.1-flash --thinking off" "$T"/op-argv-pi-*.txt >/dev/null 2>&1 && ok "op: the reference arm binds the route's model with thinking off" || bad "op: reference argv: $(head -1 "$T"/op-argv-pi-*.txt 2>/dev/null)"

echo "[cred-exec] $P ok, $F failed"
[ "$F" -eq 0 ]
