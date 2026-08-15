/**
 * ⑥ task round — acceptance ③: the LONG-HORIZON narrative. A REAL kiso
 * chat (faux provider, the task extension installed, a scripted
 * trajectory) in a REAL PTY:
 *
 *   build a 3-item plan → mark one done → kill -9 mid-round-7 shell →
 *   resume (rerun verdict) → the projection still holds the LATEST list
 *   (do-not-compact in effect) → the trajectory continues to its
 *   terminal → /compact → the projection STILL holds the latest list,
 *   the covered rounds replaced by the summary, the old echo gone.
 *
 * The second /compact half is the contract-hole checkpoint: the summary
 * layer must respect the do-not-compact tag (the boundary pulls back
 * before the list's round — runtime summarize.ts). If this check fails,
 * the STOP clause applies: the layer does not respect the tag, and the
 * round stops for a ruling.
 *
 * Everything is asserted on the DURABLE log + the projection (what the
 * model actually sees after resume and after /compact) plus the live
 * TTY's checklist cells. Zero human input: everything is injected over
 * the PTY.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectMessages } from "@vincemakes/kiso-core";
import { SessionStore } from "@vincemakes/kiso-runtime";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");
const TASK_EXT = join(fileURLToPath(new URL("../../..", import.meta.url)), "extensions", "task", "src", "kiso-task.mjs");

/** The python PTY driver — three modes:
 *  mode None (phase 1): live chat — answers the two task_set approvals
 *    and the shell approval, SIGKILLs the whole agent process group while
 *    the shell runs, then prints the capture.
 *  mode "resume" (phase 2): the one-shot resume — the rerun verdict; the
 *    process exits on its own when the trajectory completes.
 *  mode "chat" (phase 3): a FRESH chat REPL on the completed session —
 *    /compact (the off-loop summary call) then exit. The resume command
 *    is one-shot and exits after the run, so /compact runs in its own
 *    process (the product flow: resume, then continue chatting). */
const PTY_DRIVER = `
import pty, os, sys, time, select, signal

def driver(cli, home, script_path, session_id, workdir, mode):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["KISO_HOME"] = home
        os.environ["KISO_FAUX_SCRIPT"] = script_path
        # Hermetic: the real ~/.kiso must never leak in (kill9 rule).
        ext_dir = os.path.join(home, "ext")
        os.makedirs(ext_dir, exist_ok=True)
        os.environ["KISO_EXTENSIONS_DIR"] = ext_dir
        os.environ["KISO_MCP_CONFIG"] = os.path.join(home, "mcp.json")
        os.environ["KISO_SKILLS_DIR"] = os.path.join(home, "skills")
        os.chdir(workdir)
        if mode == "resume":
            os.execvp("node", ["node", cli, "resume", session_id])
        else:
            os.execvp("node", ["node", cli, session_id])
    out = b""
    full = b""
    def read_until(needle, timeout):
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
    if mode is None:
        # Live chat, SEVEN user turns (one per scripted round): plan →
        # one done → noise reads → the slow shell. The two task_set
        # rounds ask; the reads are auto-allowed; the shell asks.
        read_until("▌ ".encode(), 20)
        os.write(fd, b"go\\n")
        read_until(b"approve task_set", 30)  # the dock-less fallback question (the 0-row pty — no panel)
        os.write(fd, b"y\\n")
        read_until("▌ ".encode(), 20)
        os.write(fd, b"c1\\n")
        read_until(b"approve task_set", 30)  # the dock-less fallback question (the 0-row pty — no panel)
        os.write(fd, b"y\\n")
        read_until("▌ ".encode(), 20)
        os.write(fd, b"c2\\n")
        read_until("▌ ".encode(), 20)
        os.write(fd, b"c3\\n")
        read_until("▌ ".encode(), 20)
        os.write(fd, b"c4\\n")
        read_until("▌ ".encode(), 20)
        os.write(fd, b"c5\\n")
        read_until("▌ ".encode(), 20)
        os.write(fd, b"c6\\n")
        read_until(b"approve shell", 30)  # the dock-less fallback question (the 0-row pty — no panel)
        os.write(fd, b"y\\n")
        # The kill predicate: the SHELL's OWN started event on disk (the
        # two task_set results and the reads are durable by then). A
        # whole-file substring check is NOT enough — the shell's
        # tool_call_end line also carries "name":"shell" and lands before
        # the execution starts (an early kill breaks the scenario).
        deadline = time.time() + 20
        while time.time() < deadline:
            try:
                recs = open(os.path.join(home, "sessions", session_id + ".jsonl")).read()
                if any('"type":"tool_execution_started"' in l and '"callId":"s1"' in l for l in recs.splitlines()):
                    break
            except FileNotFoundError:
                pass
            time.sleep(0.05)
        os.kill(-pid, signal.SIGKILL)
        # The detached sleep command's own group (kill9 rule).
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
        try:
            _, status = os.waitpid(pid, 0)
        except ChildProcessError:
            status = 0
    elif mode == "resume":
        # One-shot resume: the rerun verdict; the recovery fills the
        # denial, the scripted trajectory continues to its terminal, the
        # process exits.
        read_until(b"did it apply?", 30)  # the dock-less fallback question (the 0-row pty — no panel)
        os.write(fd, b"y\\n")
        wait_exit(60)
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            _, status = os.waitpid(pid, 0)
        except ChildProcessError:
            status = 0
    else:
        # A fresh chat REPL on the completed session: /compact then exit.
        read_until("▌ ".encode(), 30)
        os.write(fd, b"/compact\\n")
        read_until(b"[/compact]", 40)
        os.write(fd, b"exit\\n")
        wait_exit(30)
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

const LIST_ONE = [
	{ text: "write the plan", status: "pending" },
	{ text: "implement", status: "pending" },
	{ text: "verify with tests", status: "pending" },
];
const LIST_TWO = [
	{ text: "write the plan", status: "done" },
	{ text: "implement", status: "active" },
	{ text: "verify with tests", status: "pending" },
];
const ECHO_TWO =
	"[task] 3 items — 1 pending, 1 active, 1 done\n[done] write the plan\n[active] implement\n[pending] verify with tests";

/** 15 turns, SEVEN user turns (a scripted round is one model response;
 *  the loop only closes a user turn at an end_turn, so each scripted
 *  round must be its own turn with an end_turn after it — /compact
 *  counts user ROUNDS, and 7 rounds give it material to cover while the
 *  task rounds stay inside the covered range): plan → one done → 4 read
 *  noise rounds → the slow shell (killed mid-run) → end (after resume) →
 *  the summary turn for the off-loop /compact call. */
const FAUX_TRAJECTORY = [
	// round 1: the plan
	{
		events: [
			{ type: "tool_call_end", callId: "t1", name: "task_set", input: { items: LIST_ONE } },
			{ type: "stop", reason: "tool_use" },
		],
	},
	{ events: [{ type: "stop", reason: "end_turn" }] },
	// round 2: one done
	{
		events: [
			{ type: "tool_call_end", callId: "t2", name: "task_set", input: { items: LIST_TWO } },
			{ type: "stop", reason: "tool_use" },
		],
	},
	{ events: [{ type: "stop", reason: "end_turn" }] },
	// rounds 3-6: noise reads (each its own round)
	...Array.from({ length: 4 }, (_, i) => [
		{
			events: [
				{ type: "tool_call_end", callId: `r${i + 1}`, name: "read_file", input: { path: "f1.txt" } },
				{ type: "stop", reason: "tool_use" },
			],
		},
		{ events: [{ type: "stop", reason: "end_turn" }] },
	]).flat(),
	// round 7: the slow shell — killed mid-execution
	{
		events: [
			{ type: "tool_call_end", callId: "s1", name: "shell", input: { command: "sleep 30 && touch marker.txt" } },
			{ type: "stop", reason: "tool_use" },
		],
	},
	// after the resume's rerun verdict: the trajectory continues to its
	// terminal
	{ events: [{ type: "stop", reason: "end_turn" }] },
	// The /compact summary turn (off-loop, consumed by the summarizer).
	{ events: [{ type: "text_delta", text: "## Goal\nserve the file reads\n## Constraints\nnothing may be dropped\n## User requests\nseven rounds of reads\n## Files and changes\nf0-f6.ts read\n## Errors and fixes\nnone\n## Current work\nseven rounds summarized\n## Next steps\nkeep going" }, { type: "stop", reason: "end_turn" }] },
];

describe("round 6 task e2e: the long-horizon narrative (kill -9 → resume → /compact)", () => {
	it("the latest task list survives the kill, the resume, AND the /compact summary", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-task-"));
		const home = join(dir, "home");
		const workdir = join(dir, "work");
		mkdirSync(workdir, { recursive: true });
		mkdirSync(join(home, "ext"), { recursive: true });
		// Install the task extension (the source file is the artifact — the file itself).
		writeFileSync(join(home, "ext", "kiso-task.mjs"), readFileSync(TASK_EXT, "utf8"), "utf8");
		writeFileSync(join(workdir, "f1.txt"), "noise\n", "utf8");
		const scriptPath = join(dir, "faux.json");
		writeFileSync(scriptPath, JSON.stringify(FAUX_TRAJECTORY), "utf8");
		writeFileSync(join(dir, "driver.py"), PTY_DRIVER, "utf8");

		// ── Phase 1: live chat; the shell round is killed mid-execution ──
		const phase1 = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(dir, "driver.py"))}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(home)}, ${JSON.stringify(scriptPath)}, "task", ${JSON.stringify(workdir)}, None)
`;
		const phase1Out = execFileSync("python3", ["-c", phase1], { encoding: "utf8", timeout: 90_000 });

		// The live TTY rendered the checklist cells (the CLI translated the
		// tagged results into the tui's checklist shape — brick glyphs).
		expect(phase1Out).toContain("3 items — 3 pending, 0 active, 0 done");
		expect(phase1Out).toContain("3 items — 1 pending, 1 active, 1 done");
		expect(phase1Out).toContain("  ▣ write the plan");
		expect(phase1Out).toContain("  ▖ implement");
		expect(phase1Out).toContain("  □ verify with tests");

		const store = new SessionStore(join(home, "sessions"));
		const records = store.load("task");
		const events = records.map((r) => r.event);
		// Both task_set results landed with the do-not-compact tag; the
		// six earlier runs completed (one terminal each), the SHELL run
		// died mid-flight — its terminal never landed, the marker never
		// appeared.
		const tagged = events.filter(
			(e): e is Extract<(typeof events)[number], { type: "tool_result" }> => e.type === "tool_result" && e.callId === "t2",
		);
		expect(tagged).toHaveLength(1);
		expect(tagged[0]!.tags).toEqual(["do-not-compact"]);
		expect(String(tagged[0]!.content)).toBe(ECHO_TWO);
		expect(events.filter((e) => e.type === "terminal")).toHaveLength(6);
		expect(existsSync(join(workdir, "marker.txt"))).toBe(false);
		// do-not-compact in effect (the kill -9 side): the projection the resumed
		// model would see ALREADY holds the latest list.
		expect(JSON.stringify(projectMessages(events))).toContain("1 pending, 1 active, 1 done");

		// ── Phase 2: a FRESH process resumes; rerun verdict; the trajectory
		//    continues to its terminal (the one-shot resume exits on its
		//    own — /compact runs in its own process, phase 3) ──
		const phase2 = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(dir, "driver.py"))}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(home)}, ${JSON.stringify(scriptPath)}, "task", ${JSON.stringify(workdir)}, "resume")
`;
		const phase2Out = execFileSync("python3", ["-c", phase2], { encoding: "utf8", timeout: 90_000 });
		expect(phase2Out).toContain("did it apply?"); // the dock-less fallback question — the driver's 0-row pty keeps the panel out

		const records2 = new SessionStore(join(home, "sessions")).load("task");
		const events2 = records2.map((r) => r.event);
		expect(events2.some((e) => e.type === "terminal")).toBe(true);
		// The interrupted shell never completed; the recovery filled the
		// denial and the trajectory ran on (the marker stays absent).
		expect(existsSync(join(workdir, "marker.txt"))).toBe(false);
		// do-not-compact in effect (the resume side): the continued projection still
		// holds the latest list.
		expect(JSON.stringify(projectMessages(events2))).toContain("1 pending, 1 active, 1 done");

		// ── Phase 3: a FRESH chat REPL on the completed session; /compact ──
		const phase3 = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(dir, "driver.py"))}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(home)}, ${JSON.stringify(scriptPath)}, "task", ${JSON.stringify(workdir)}, "chat")
`;
		const phase3Out = execFileSync("python3", ["-c", phase3], { encoding: "utf8", timeout: 90_000 });
		expect(phase3Out).toContain("[/compact]");

		const records3 = new SessionStore(join(home, "sessions")).load("task");
		const events3 = records3.map((r) => r.event);
		expect(events3.some((e) => e.type === "summarized")).toBe(true);

		// THE contract-hole checkpoint: after /compact, the projection
		// still holds the LATEST list (the summary layer respected the
		// do-not-compact tag — the boundary pulled back before its round),
		// the covered rounds became the summary, and round 1's superseded
		// echo is gone.
		const projText = JSON.stringify(projectMessages(events3));
		expect(projText).toContain("1 pending, 1 active, 1 done");
		// The full echo rides the projection VERBATIM (JSON-escaped \n —
		// compare against the escaped form).
		expect(projText).toContain(JSON.stringify(ECHO_TWO).slice(1, -1));
		expect(projText).toContain("## Goal\\nserve the file reads\\n## Constraints\\nnothing may be dropped\\n## User requests\\nseven rounds of reads\\n## Files and changes\\nf0-f6.ts read\\n## Errors and fixes\\nnone\\n## Current work\\nseven rounds summarized\\n## Next steps\\nkeep going");
		expect(projText).not.toContain("3 pending, 0 active, 0 done");
	}, 240_000);
});
