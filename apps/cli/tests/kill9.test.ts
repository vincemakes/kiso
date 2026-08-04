/**
 * E 区 — the kill -9 gate: kiso survives a hard kill.
 *
 * A REAL kiso chat (faux provider, a scripted trajectory that edits three
 * files, with a SLOW shell command in the middle) is started in a REAL
 * PTY. The moment the second execution (the slow shell) reports
 * tool_execution_started on disk, the whole AGENT process group is killed
 * with SIGKILL — no graceful shutdown, no signal handler — and so is the
 * slow command's own (detached) group, discovered via ps: the shell tool
 * spawns detached so its timeout can kill the whole tree, and a real
 * kill -9 of the scenario must stop the running command too.
 *
 * Assertions: the on-disk event stream loads without corruption; there is
 * EXACTLY ONE uncertain execution; the marker the slow command would have
 * written does not exist. Then a fresh `kiso resume` re-presents the
 * uncertain execution, the human verdict is rerun (injected over the
 * PTY), the original trajectory continues — the third edit happens — the
 * terminal lands, and the filesystem state matches the expectation.
 *
 * Zero human input: everything is injected over the PTY.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { executionLedger } from "@vincemakes/kiso-core";
import { SessionStore } from "@vincemakes/kiso-runtime";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** The python PTY driver: starts a real child in a real PTY, injects the
 *  given keys at the given probes, waits for needles, and (optionally)
 *  SIGKILLs the process group at a predicate. Returns the captured output. */
const PTY_DRIVER = `
import pty, os, sys, time, select, signal

def driver(cli, home, script_path, session_id, workdir, kills_at, resume_keys):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["KISO_HOME"] = home
        os.environ["KISO_FAUX_SCRIPT"] = script_path
        # Hermetic: the real ~/.kiso may hold extensions + an MCP config —
        # the gate must never load them (an MCP npx server at startup makes
        # the CLI un-killable mid-connect).
        ext_dir = os.path.join(home, "ext")
        os.makedirs(ext_dir, exist_ok=True)
        os.environ["KISO_EXTENSIONS_DIR"] = ext_dir
        os.environ["KISO_MCP_CONFIG"] = os.path.join(home, "mcp.json")
        os.chdir(workdir)
        if resume_keys is None:
            os.execvp("node", ["node", cli, session_id])
        else:
            # The SPEC: "kiso resume 同 session" — the dedicated command.
            os.execvp("node", ["node", cli, "resume", session_id])
    out = b""    # working buffer: consumed past every matched needle
    full = b""   # the complete capture, printed at the end
    def read_until(needle, timeout):
        # Wait for the needle, then CONSUME past it: a matched prompt must
        # never re-match against stale buffer bytes (that answered the wrong
        # question once — a stray "y" fed the next approval prompt).
        nonlocal out, full
        end = time.time() + timeout
        while time.time() < end:
            idx = out.find(needle)
            if idx >= 0:
                out = out[idx + len(needle):]
                return True
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    data = os.read(fd, 4096)
                    out += data
                    full += data
                except OSError:
                    return False
        return False
    def wait_exit(timeout):
        # Read until the child exits (EOF) or the deadline passes.
        nonlocal out, full
        end = time.time() + timeout
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    data = os.read(fd, 4096)
                    if not data:
                        return
                    out += data
                    full += data
                except OSError:
                    return
    if resume_keys is None:
        # Live chat: send one user turn, then answer the two approvals,
        # then wait for the kill predicate.
        read_until(b"you> ", 20)
        os.write(fd, b"go\\n")
        read_until(b"approve edit_file", 30)
        os.write(fd, b"y\\n")
        read_until(b"approve shell", 30)
        os.write(fd, b"y\\n")
        # The kill predicate: the JSONL holds TWO tool_execution_started.
        deadline = time.time() + 20
        while time.time() < deadline:
            try:
                recs = open(os.path.join(home, "sessions", session_id + ".jsonl")).read()
                starts = [l for l in recs.split("\\n") if "tool_execution_started" in l]
                if len(starts) >= 2:
                    break
            except FileNotFoundError:
                pass
            time.sleep(0.05)
        os.kill(-pid, signal.SIGKILL)   # the WHOLE agent process group
        # The shell tool spawns its commands DETACHED (own process group) so
        # a timeout can kill the whole tree — that same detachment means the
        # agent's group SIGKILL does not reach the running command, and the
        # interrupted execution would "complete" 30s later, writing the
        # marker. A real kill -9 of the scenario kills the command's group
        # too: discover it by its command line and SIGKILL it as well.
        import subprocess
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
        _, status = os.waitpid(pid, 0)
    else:
        # Resume: answer the uncertain verdict, then every approval that
        # follows. The trajectory runs to its terminal and the process
        # exits on its own.
        # NOTE: the question reads "(r)erun / (a)bandon" — the substring
        # "rerun / (a)bandon" does NOT exist in it (the ")" splits it);
        # "(a)bandon" is the shared unique tail of both verdict questions.
        read_until(b"(a)bandon", 25)
        os.write(fd, resume_keys[0].encode() + b"\\n")
        for _ in range(4):
            if read_until(b"approve ", 15):
                os.write(fd, b"y\\n")
            else:
                break
        wait_exit(40)
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            _, status = os.waitpid(pid, 0)
        except ChildProcessError:
            status = 0
    sys.stdout.write(full.decode(errors="replace"))
    sys.exit(0)
`;

const FAUX_TRAJECTORY = [
	{
		events: [
			{ type: "tool_call_end", callId: "e1", name: "edit_file", input: { path: "f1.txt", search: "OLD", replace: "NEW" } },
			{ type: "stop", reason: "tool_use" },
		],
	},
	{
		events: [
			{ type: "tool_call_end", callId: "s1", name: "shell", input: { command: "sleep 30 && touch marker.txt" } },
			{ type: "stop", reason: "tool_use" },
		],
	},
	{
		events: [
			{ type: "tool_call_end", callId: "e3", name: "edit_file", input: { path: "f3.txt", search: "OLD", replace: "NEW" } },
			{ type: "stop", reason: "tool_use" },
		],
	},
	{ events: [{ type: "stop", reason: "end_turn" }] },
];

describe("kill -9 gate (E 区)", () => {
	it("a SIGKILL mid-execution leaves a loadable stream, one uncertain execution, and a rerun-verdict resume that completes the trajectory", async () => {
		// Two real processes, a real PTY, a real kill — far beyond the 5s
		// default vitest timeout, so the timeout is explicit (third arg).
		// 180s: the phase-2 approval loop and kill predicate have generous
		// internal windows; the execFileSync limits are 90s each.
		const dir = mkdtempSync(join(tmpdir(), "kiso-k9-"));
		const home = join(dir, "home");
		const workdir = join(dir, "work");
		mkdirSync(workdir, { recursive: true });
		const scriptPath = join(dir, "faux.json");
		writeFileSync(join(dir, "faux.json"), JSON.stringify(FAUX_TRAJECTORY), "utf8");
		writeFileSync(join(workdir, "f1.txt"), "OLD", "utf8");
		writeFileSync(join(workdir, "f3.txt"), "OLD", "utf8");
		writeFileSync(join(dir, "driver.py"), PTY_DRIVER, "utf8");

		// ── Phase 1: live chat, killed at the second execution ──
		const phase1 = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(dir, "driver.py"))}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(home)}, ${JSON.stringify(scriptPath)}, "k9", ${JSON.stringify(workdir)}, None, None)
`;
		execFileSync("python3", ["-c", phase1], { encoding: "utf8", timeout: 90_000 });

		// The on-disk stream loads without corruption; exactly ONE
		// execution is uncertain; the marker never appeared.
		const store = new SessionStore(join(home, "sessions"));
		const records = store.load("k9");
		const ledger = executionLedger(records.map((r) => r.event));
		const uncertain = [...ledger.values()].filter((r) => r.status === "uncertain");
		expect(uncertain).toHaveLength(1);
		expect(uncertain[0]!.name).toBe("shell");
		expect(existsSync(join(workdir, "marker.txt"))).toBe(false);
		// The first edit DID land before the kill.
		expect(readFileSync(join(workdir, "f1.txt"), "utf8")).toBe("NEW");
		// No terminal was written (the run died mid-flight).
		expect(records.some((r) => r.event.type === "terminal")).toBe(false);

		// ── Phase 2: a FRESH process resumes; verdict rerun; trajectory
		//    continues — the third edit happens, the terminal lands. ──
		const phase2 = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(dir, "driver.py"))}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(home)}, ${JSON.stringify(scriptPath)}, "k9", ${JSON.stringify(workdir)}, None, ["r"])
`;
		const out = execFileSync("python3", ["-c", phase2], { encoding: "utf8", timeout: 90_000 });
		expect(out).toContain("(r)erun / (a)bandon");
		// The trajectory visibly continued: the THIRD file's edit ran, not a
		// replay of the first one.
		expect(out).toContain("f3.txt");

		// The trajectory completed: the third edit happened, the terminal
		// is durable, the marker still never appeared.
		const records2 = new SessionStore(join(home, "sessions")).load("k9");
		expect(records2.some((r) => r.event.type === "terminal")).toBe(true);
		expect(readFileSync(join(workdir, "f3.txt"), "utf8")).toBe("NEW");
		expect(existsSync(join(workdir, "marker.txt"))).toBe(false);
		// The resolution is durable, exactly one.
		expect(records2.filter((r) => r.event.type === "tool_execution_resolved")).toHaveLength(1);
	}, 180_000);
});
