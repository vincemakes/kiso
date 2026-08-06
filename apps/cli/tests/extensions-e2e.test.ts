/**
 * E1 — the extensions gate: a REAL kiso chat (faux provider, one extension
 * installed) through the CLI's topmost entry.
 *
 * The extension allows reads, denies destructive shell commands, and asks
 * for everything else. In ONE live PTY session: the read is auto-allowed
 * (no approval prompt appears), the first write is still asked of the
 * human (y injected), the dangerous shell is denied (the model receives
 * the [Permission denied] result), and a SECOND write's pause is where the
 * whole agent process group gets SIGKILLed — a pause is a stable state, so
 * the kill lands deterministically mid-trajectory.
 *
 * A FRESH process resumes: the already-decided calls are never re-asked
 * (exactly the ONE new request is re-presented), and the policy is never
 * re-run — the extension's marker file (one line per decide() call) must
 * not grow across the kill.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { SessionStore } from "@vincemakes/kiso-runtime";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** The python PTY driver: chat phase answers the first write, watches the
 *  shell denial, and SIGKILLs the whole agent process group while the
 *  second write's pause is pending; resume phase answers the re-presented
 *  request and waits for the trajectory to complete. */
const PTY_DRIVER = `
import pty, os, sys, time, select, signal

def driver(cli, home, script_path, ext_dir, marker_path, session_id, workdir, resume):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["KISO_HOME"] = home
        os.environ["KISO_FAUX_SCRIPT"] = script_path
        os.environ["KISO_EXTENSIONS_DIR"] = ext_dir
        os.environ["KISO_EXT_MARKER"] = marker_path
        os.chdir(workdir)
        os.execvp("node", ["node", cli, "resume", session_id] if resume else ["node", cli, session_id])
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
    if not resume:
        read_until("▌ ".encode(), 20)
        os.write(fd, b"go\\n")
        read_until(b"approve write_file", 30)
        os.write(fd, b"y\\n")
        read_until(b"[Permission denied]", 30)
        read_until(b"approve write_file", 30)
        time.sleep(0.5)
        os.kill(-pid, signal.SIGKILL)
        try:
            _, status = os.waitpid(pid, 0)
        except ChildProcessError:
            status = 0
    else:
        read_until(b"approve write_file", 25)
        os.write(fd, b"y\\n")
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

/** Five scripted turns: read (auto-allowed), write (human), destructive
 *  shell (denied), a second write whose pause hosts the kill, then done. */
const FAUX_TRAJECTORY = [
	{
		events: [
			{ type: "tool_call_end", callId: "r1", name: "read_file", input: { path: "notes.txt" } },
			{ type: "stop", reason: "tool_use" },
		],
	},
	{
		events: [
			{ type: "tool_call_end", callId: "w1", name: "write_file", input: { path: "out.txt", content: "hello" } },
			{ type: "stop", reason: "tool_use" },
		],
	},
	{
		events: [
			{ type: "tool_call_end", callId: "s1", name: "shell", input: { command: "git reset --hard" } },
			{ type: "stop", reason: "tool_use" },
		],
	},
	{
		events: [
			{ type: "tool_call_end", callId: "w2", name: "write_file", input: { path: "out2.txt", content: "world" } },
			{ type: "stop", reason: "tool_use" },
		],
	},
	{ events: [{ type: "text_delta", text: "the tour is done" }, { type: "stop", reason: "end_turn" }] },
];

/** The test extension: mirrors safe-defaults and appends one marker line
 *  per decide() call — the cross-process proof that the policy never
 *  re-runs after the kill. */
const EXTENSION = `
import { appendFileSync } from "node:fs";

export default {
	name: "safe-test",
	approvals: [
		{
			decide(call) {
				appendFileSync(process.env.KISO_EXT_MARKER, call.name + "\\n", "utf8");
				if (["read_file", "list_dir", "search_text"].includes(call.name)) return { action: "allow" };
				if (
					call.name === "shell" &&
					/\\bgit\\s+(stash|reset|checkout\\s+--)|rm\\s+-rf/.test(String(call.input.command ?? ""))
				) {
					return { action: "deny", reason: "destructive command — refused by safe-test" };
				}
				return { action: "ask" };
			},
		},
	],
};
`;

describe("E1 extensions gate (extensions-e2e)", () => {
	it("read auto-allows, write asks, dangerous shell is denied — then a kill -9 resume never re-asks nor re-runs the policy", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-e1-"));
		const home = join(dir, "home");
		const workdir = join(dir, "work");
		const extdir = join(dir, "ext");
		const marker = join(dir, "marker.log");
		mkdirSync(workdir, { recursive: true });
		mkdirSync(extdir, { recursive: true });
		writeFileSync(join(workdir, "notes.txt"), "hello notes", "utf8");
		writeFileSync(join(dir, "faux.json"), JSON.stringify(FAUX_TRAJECTORY), "utf8");
		writeFileSync(join(extdir, "safe-test.mjs"), EXTENSION, "utf8");
		writeFileSync(join(dir, "driver.py"), PTY_DRIVER, "utf8");

		// ── Phase 1: live chat — the three verdicts, killed mid-pause ──
		const phase1 = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(dir, "driver.py"))}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(home)}, ${JSON.stringify(join(dir, "faux.json"))}, ${JSON.stringify(extdir)}, ${JSON.stringify(marker)}, "e1", ${JSON.stringify(workdir)}, False)
`;
		const { env } = isolatedEnv();
		const out1 = execFileSync("python3", ["-c", phase1], { encoding: "utf8", timeout: 90_000, env });
		expect(out1).toContain("[1 extension: safe-test]");
		expect(out1).not.toContain("read_file needs approval"); // the read was AUTO-allowed — no prompt
		expect(out1).toContain("approve write_file"); // the write WAS asked of the human
		expect(out1).toContain("[Permission denied]"); // the destructive shell was denied to the model
		// Exactly one decide() per called tool — the marker is the policy's own log.
		expect(readFileSync(marker, "utf8").trim().split("\n")).toEqual(["read_file", "write_file", "shell", "write_file"]);

		const store = new SessionStore(join(home, "sessions"));
		const records = store.load("e1");
		expect(records.some((r) => r.event.type === "terminal")).toBe(false); // killed mid-trajectory
		const decided = records
			.map((r) => r.event)
			.filter((e): e is import("@vincemakes/kiso-core").Event & { type: "permission_decided" } => e.type === "permission_decided");
		expect(decided).toHaveLength(3); // read + write1 + shell
		expect(decided.filter((e) => e.decidedBy !== undefined)).toHaveLength(2); // read + shell by POLICY
		expect(decided.find((e) => e.callId === "w1")?.decidedBy).toBeUndefined(); // the first write was HUMAN-decided
		expect(decided.some((e) => e.callId === "w2")).toBe(false); // the second write was never decided

		// ── Phase 2: a FRESH process resumes — exactly the ONE undecided
		//    request is re-presented; the already-decided calls are not
		//    re-asked and the policy never re-runs (the marker does not grow).
		const phase2 = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(dir, "driver.py"))}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(home)}, ${JSON.stringify(join(dir, "faux.json"))}, ${JSON.stringify(extdir)}, ${JSON.stringify(marker)}, "e1", ${JSON.stringify(workdir)}, True)
`;
		const out2 = execFileSync("python3", ["-c", phase2], { encoding: "utf8", timeout: 90_000, env });
		expect(out2).toContain("done"); // the trajectory completed
		expect((out2.match(/approve write_file/g) ?? [])).toHaveLength(1); // ONLY the new request — 已裁决的不再问
		expect(out2).not.toContain("read_file needs approval");
		expect(out2).not.toContain("(a)bandon"); // no uncertain executions
		expect(readFileSync(marker, "utf8").trim().split("\n")).toEqual(["read_file", "write_file", "shell", "write_file"]); // policy 不重跑
		// Both writes actually landed.
		expect(readFileSync(join(workdir, "out.txt"), "utf8")).toBe("hello");
		expect(readFileSync(join(workdir, "out2.txt"), "utf8")).toBe("world");

		const records2 = new SessionStore(join(home, "sessions")).load("e1");
		expect(records2.some((r) => r.event.type === "terminal")).toBe(true);
	}, 180_000);
});
