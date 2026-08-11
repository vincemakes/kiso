#!/usr/bin/env bash
#
# R-D 0.1.45 (deliverable F) — the scripted kill-9 proof against the
# PUBLISHED binary, the hero asset the README references
# (scripts/demo-kill9.sh).
#
# The story, twice in a row with a FRESH KISO_HOME each run:
#   a real kiso chat (faux provider, a scripted trajectory: edit f1.txt →
#   a slow shell `sleep 30 && touch marker.txt` → edit f3.txt) starts in a
#   real PTY; the two approvals are answered; the moment the slow shell
#   reports tool_execution_started on disk, the agent's WHOLE process
#   group is SIGKILLed — no graceful shutdown, no signal handler — and so
#   is the shell's own detached group (a real kill -9 must stop the
#   running command too). Then a FRESH `kiso resume` re-presents the
#   uncertain execution, the human verdict rerun is given, the trajectory
#   continues (the third edit happens), and the terminal lands durable.
#
# Assertions per run (the release report carries the evidence):
#   phase 1 — the stream loads uncorrupted, ZERO durable resolutions
#     (the kill landed mid-flight), no terminal, the marker never
#     appeared, the first edit DID land;
#   phase 2 — the uncertain is re-presented EXACTLY ONCE and answered
#     rerun, exactly ONE durable resolution, the terminal landed,
#     the marker STILL never appeared, the third edit happened.
#
# KISO_BIN — the binary to drive. Defaults to `kiso`, the global install
# (i.e. the published binary — the README's claim). An absolute path to a
# .js file drives a repo build instead (the driver wraps `node` for it).
#
# Depends on python3 (the runtime already requires it for the session
# store's kernel-flock helper). Exit 0 = both runs green; exit 1 = any
# assertion failed (the run dirs are kept, with the transcripts).

set -u

BIN="${KISO_BIN:-kiso}"
FAILED=0

check() { # <name> <exit-code>
	if [ "$2" -eq 0 ]; then
		printf '      [PASS] %s\n' "$1"
	else
		printf '      [FAIL] %s\n' "$1"
		FAILED=1
	fi
}

# probe <session-jsonl> <workdir> → the on-disk facts, one line:
#   loads=0|1 started=<n> resolved=<n> terminal=0|1 marker=0|1 f1=<t> f3=<t>
probe() {
	python3 - "$1" "$2" <<'PY'
import json, sys, os
path, workdir = sys.argv[1:3]
lines = [l for l in open(path) if l.strip()]
ok = True
types = []
for l in lines:
	try:
		types.append(json.loads(l)["event"]["type"])
	except Exception:
		ok = False
f1 = open(os.path.join(workdir, "f1.txt")).read().strip()
f3 = open(os.path.join(workdir, "f3.txt")).read().strip()
print("loads=%d started=%d resolved=%d terminal=%d marker=%d f1=%s f3=%s" % (
	1 if ok else 0,
	types.count("tool_execution_started"),
	types.count("tool_execution_resolved"),
	1 if "terminal" in types else 0,
	1 if os.path.exists(os.path.join(workdir, "marker.txt")) else 0,
	f1, f3))
PY
}

# phase 1: a live chat, two approvals, SIGKILL mid-execution (the agent's
# whole process group plus the slow command's own detached group).
phase1() { # <bin> <home> <faux-json> <workdir> <session-id>
	python3 - "$@" <<'PY'
import pty, os, sys, time, select, signal, subprocess

def main():
	cli, home, script, workdir, sid = sys.argv[1:6]
	pid, fd = pty.fork()
	if pid == 0:
		os.environ["KISO_HOME"] = home
		os.environ["KISO_FAUX_SCRIPT"] = script
		ext = os.path.join(home, "ext")
		os.makedirs(ext, exist_ok=True)
		os.environ["KISO_EXTENSIONS_DIR"] = ext
		os.environ["KISO_MCP_CONFIG"] = os.path.join(home, "mcp.json")
		os.chdir(workdir)
		if cli.endswith(".js"):
			args = ["node", cli, sid]
		else:
			args = [cli, sid]
		os.execvp(args[0], args)
	buf = b""
	full = b""
	def read_until(needle, timeout):
		# wait for the needle, then CONSUME past it — a matched prompt must
		# never re-match against stale buffer bytes
		nonlocal buf, full
		end = time.time() + timeout
		while time.time() < end:
			idx = buf.find(needle)
			if idx >= 0:
				buf = buf[idx + len(needle):]
				return True
			r, _, _ = select.select([fd], [], [], 0.2)
			if r:
				try:
					data = os.read(fd, 4096)
					if not data:
						return False
					buf += data
					full += data
				except OSError:
					return False
		return False
	if not read_until(b"\xe2\x96\x8c ", 25):  # the ▌ input brick
		print("FAIL: the input brick never appeared")
		sys.exit(1)
	os.write(fd, b"go\n")
	if not read_until(b"approve edit_file", 30):
		print("FAIL: the edit approval never appeared")
		sys.exit(1)
	os.write(fd, b"y\n")
	if not read_until(b"approve shell", 30):
		print("FAIL: the shell approval never appeared")
		sys.exit(1)
	os.write(fd, b"y\n")
	# the kill predicate: TWO tool_execution_started on disk — the slow
	# shell is executing right now
	deadline = time.time() + 20
	while time.time() < deadline:
		try:
			recs = open(os.path.join(home, "sessions", sid + ".jsonl")).read()
			if recs.count("tool_execution_started") >= 2:
				break
		except FileNotFoundError:
			pass
		time.sleep(0.05)
	os.kill(-pid, signal.SIGKILL)  # the WHOLE agent process group
	# the shell tool spawns its commands DETACHED (own process group) — the
	# agent's group kill does not reach the running command, and the
	# interrupted execution would "complete" 30s later writing the marker.
	# A real kill -9 of the scenario kills the command's group too.
	try:
		ps = subprocess.check_output(["ps", "-eo", "pid=,pgid=,command="]).decode(errors="replace")
	except Exception:
		ps = ""
	for line in ps.splitlines():
		parts = line.split(None, 2)
		if len(parts) < 3 or "marker.txt" not in parts[2]:
			continue
		try:
			os.kill(-int(parts[1]), signal.SIGKILL)
		except (ProcessLookupError, ValueError):
			pass
	time.sleep(0.5)
	try:
		os.kill(pid, signal.SIGKILL)
	except ProcessLookupError:
		pass
	try:
		os.waitpid(pid, 0)
	except ChildProcessError:
		pass
	sys.stdout.write(full.decode(errors="replace"))
	sys.exit(0)

main()
PY
}

# phase 2: a FRESH process resumes the session; the uncertain verdict is
# answered rerun; every approval that follows is answered; the trajectory
# runs to its terminal and the process exits on its own.
phase2() { # <bin> <home> <faux-json> <workdir> <session-id>
	python3 - "$@" <<'PY'
import pty, os, sys, time, select, signal

def main():
	cli, home, script, workdir, sid = sys.argv[1:6]
	pid, fd = pty.fork()
	if pid == 0:
		os.environ["KISO_HOME"] = home
		os.environ["KISO_FAUX_SCRIPT"] = script
		ext = os.path.join(home, "ext")
		os.makedirs(ext, exist_ok=True)
		os.environ["KISO_EXTENSIONS_DIR"] = ext
		os.environ["KISO_MCP_CONFIG"] = os.path.join(home, "mcp.json")
		os.chdir(workdir)
		if cli.endswith(".js"):
			args = ["node", cli, "resume", sid]
		else:
			args = [cli, "resume", sid]
		os.execvp(args[0], args)
	buf = b""
	full = b""
	def read_until(needle, timeout):
		nonlocal buf, full
		end = time.time() + timeout
		while time.time() < end:
			idx = buf.find(needle)
			if idx >= 0:
				buf = buf[idx + len(needle):]
				return True
			r, _, _ = select.select([fd], [], [], 0.2)
			if r:
				try:
					data = os.read(fd, 4096)
					if not data:
						return False
					buf += data
					full += data
				except OSError:
					return False
		return False
	if not read_until(b"did it apply?", 30):
		print("FAIL: the uncertain verdict question never appeared")
		sys.exit(1)
	os.write(fd, b"y\n")  # (y)es — the verdict rerun
	# answer every question (the rerun shell needs no new approval — its
	# pre-kill allow is durable — and the third edit's does) until the
	# process exits on its own; the rerun's 30s sleep bounds the wait
	end = time.time() + 150
	while time.time() < end:
		if b"did it apply?" in buf:
			buf = buf[buf.find(b"did it apply?") + len(b"did it apply?"):]
			os.write(fd, b"y\n")
			continue
		if b"approve " in buf:
			buf = buf[buf.find(b"approve ") + len(b"approve "):]
			os.write(fd, b"y\n")
			continue
		r, _, _ = select.select([fd], [], [], 0.2)
		if r:
			try:
				data = os.read(fd, 4096)
			except OSError:
				break
			if not data:
				break
			buf += data
			full += data
	sys.stdout.write(full.decode(errors="replace"))
	sys.exit(0)

main()
PY
}

# one full cycle: fresh home + workdir, phase 1, phase 2, assertions.
run_once() {
	local n="$1" home workdir sid facts
	home="$(mktemp -d "${TMPDIR:-/tmp}/kiso-demo-k9-home.XXXXXX")"
	workdir="$(mktemp -d "${TMPDIR:-/tmp}/kiso-demo-k9-work.XXXXXX")"
	sid="k9"
	printf 'OLD' > "$workdir/f1.txt"
	printf 'OLD' > "$workdir/f3.txt"
	printf '%s' '[{"events":[{"type":"tool_call_end","callId":"e1","name":"edit_file","input":{"path":"f1.txt","search":"OLD","replace":"NEW"}},{"type":"stop","reason":"tool_use"}]},{"events":[{"type":"tool_call_end","callId":"s1","name":"shell","input":{"command":"sleep 30 && touch marker.txt"}},{"type":"stop","reason":"tool_use"}]},{"events":[{"type":"tool_call_end","callId":"e3","name":"edit_file","input":{"path":"f3.txt","search":"OLD","replace":"NEW"}},{"type":"stop","reason":"tool_use"}]},{"events":[{"type":"stop","reason":"end_turn"}]}]' > "$home/faux.json"

	printf '\n=== demo-kill9: run %s (a fresh KISO_HOME) ===\n' "$n"
	printf '  [%s/2] phase 1 — a real chat, two approvals, SIGKILL mid-execution\n' "$n"
	phase1 "$BIN" "$home" "$home/faux.json" "$workdir" "$sid" > "$home/phase1.out" 2>&1
	if [ $? -ne 0 ]; then
		printf '      [FAIL] phase 1 driver failed — transcript tail:\n'
		tail -5 "$home/phase1.out" | sed 's/^/        /'
		FAILED=1
	else
		facts="$(probe "$home/sessions/$sid.jsonl" "$workdir")"
		check "the event stream loads without corruption" "$(printf '%s' "$facts" | grep -q 'loads=1'; echo $?)"
		check "zero durable resolutions at the kill (mid-flight)" "$(printf '%s' "$facts" | grep -q 'resolved=0'; echo $?)"
		check "no terminal was written" "$(printf '%s' "$facts" | grep -q 'terminal=0'; echo $?)"
		check "the marker never appeared" "$(printf '%s' "$facts" | grep -q 'marker=0'; echo $?)"
		check "the first edit DID land before the kill" "$(printf '%s' "$facts" | grep -q 'f1=NEW'; echo $?)"
	fi

	printf '  [%s/2] phase 2 — a fresh process resumes, verdict rerun, terminal\n' "$n"
	phase2 "$BIN" "$home" "$home/faux.json" "$workdir" "$sid" > "$home/phase2.out" 2>&1
	if [ $? -ne 0 ]; then
		printf '      [FAIL] phase 2 driver failed — transcript tail:\n'
		tail -5 "$home/phase2.out" | sed 's/^/        /'
		FAILED=1
	else
		facts="$(probe "$home/sessions/$sid.jsonl" "$workdir")"
		local asked
		asked="$(grep -c 'did it apply?' "$home/phase2.out" || true)"
		check "the uncertain is re-presented exactly once" "$( [ "$asked" -eq 1 ]; echo $?)"
		check "exactly one durable resolution" "$(printf '%s' "$facts" | grep -q 'resolved=1'; echo $?)"
		check "the terminal landed and is durable" "$(printf '%s' "$facts" | grep -q 'terminal=1'; echo $?)"
		check "the marker STILL never appeared" "$(printf '%s' "$facts" | grep -q 'marker=0'; echo $?)"
		check "the third edit happened — trajectory continued" "$(printf '%s' "$facts" | grep -q 'f3=NEW'; echo $?)"
	fi

	if [ "$FAILED" -eq 0 ]; then
		printf '      run %s: PASS\n' "$n"
		rm -rf "$home" "$workdir"
	else
		printf '      run %s: FAIL — kept for inspection: %s (phase1.out / phase2.out)\n' "$n" "$home"
	fi
}

run_once 1
run_once 2

if [ "$FAILED" -eq 0 ]; then
	printf '\ndemo-kill9: 2/2 runs green — %s survives kill -9 (a fresh KISO_HOME per run)\n' "$BIN"
	exit 0
fi
printf '\ndemo-kill9: FAILED\n'
exit 1
