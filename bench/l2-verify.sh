#!/bin/sh
# l2-verify.sh <repo> <work> — L2 (service): the FINAL server.js answers
# /sum correctly on a fresh port of the verifier's own. Prints pass | fail.
# Also records, as a fact and not a verdict, whether a server was left
# listening on the leg's port after the arm exited (<work>/l2-left-running),
# and stops it — by the PID listening on that port, never by name.
set -u
R=$1; W=$2
LEG_PORT=$(cat "$R/.port" 2>/dev/null || echo "")
LEFT=no
if [ -n "$LEG_PORT" ]; then
	PIDS=$(lsof -nP -t -iTCP:"$LEG_PORT" -sTCP:LISTEN 2>/dev/null || true)
	if [ -n "$PIDS" ]; then
		LEFT=yes
		for p in $PIDS; do kill "$p" 2>/dev/null || true; done
	fi
fi
echo "$LEFT" > "$W/l2-left-running"
V=$(mktemp -d)
cp -R "$R/." "$V/"
PORT=$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')
echo "$PORT" > "$V/.port"
( cd "$V" && exec node server.js ) > "$V/server.log" 2>&1 &
SP=$!
OK=fail
for _ in 1 2 3 4 5 6 7 8 9 10; do
	sleep 0.5
	A=$(curl -s "http://127.0.0.1:$PORT/sum?a=2&b=3" 2>/dev/null || true)
	[ -n "$A" ] && break
done
B=$(curl -s "http://127.0.0.1:$PORT/sum?a=10&b=-4" 2>/dev/null || true)
node -e '
const [a, b] = process.argv.slice(1).map((s) => { try { return JSON.parse(s); } catch { return null; } });
process.exit(a && Number(a.sum) === 5 && typeof a.sum === "number" && b && b.sum === 6 ? 0 : 1);
' "$A" "$B" && OK=pass
kill "$SP" 2>/dev/null || true
wait "$SP" 2>/dev/null || true
rm -rf "$V"
echo "$OK"
