/**
 * End-to-end: the BUILT CLI (plain node, no tsx) holds a durable session
 * across process boundaries — chat in one process, resume in another,
 * sessions listing, and the JSONL shows both runs. Requires the CLI build
 * (npm run check builds before testing).
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SessionStore } from "@vincemakes/kiso-runtime";
import { readdirSync } from "node:fs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

function runCli(args: string[], input: string, env: Record<string, string>) {
	return spawnSync("node", [CLI, ...args], {
		input,
		encoding: "utf8",
		env: { ...process.env, ...env },
		timeout: 30_000,
	});
}

describe("kiso CLI (built artifact, faux mode)", () => {
	it("chat → resume in a new process → sessions listing → durable two-run history", async () => {
		const home = mkdtempSync(join(tmpdir(), "kiso-cli-"));
		const id = "e2e";

		// Process 1: interactive chat, one turn, exit.
		const first = runCli(["chat", id], "look around\nexit\n", { KISO_HOME: home });
		expect(first.status, first.stderr).toBe(0);
		expect(first.stdout).toContain(`session ${id}`);
		expect(first.stdout).toContain("faux model");

		// Process 2: resume the same session from disk — a NEW process sees
		// the first run's history and completes another turn.
		const second = runCli(["resume", id, "continue"], "", { KISO_HOME: home });
		expect(second.status, second.stderr).toBe(0);
		expect(second.stdout).toContain("done"); // the honest terminal

		// Process 3: sessions lists the durable session.
		const sessions = runCli(["sessions"], "", { KISO_HOME: home });
		expect(sessions.status).toBe(0);
		expect(sessions.stdout).toContain(id);

		// The JSONL carries both runs — the cross-process trajectory.
		const store = new SessionStore(join(home, "sessions"));
		const records = store.load(id);
		expect(records.length).toBeGreaterThan(0);
		expect(new Set(records.map((r) => r.runId)).size).toBe(2);
		// seq is contiguous across the process boundary.
		const seqs = records.map((r) => r.event.seq);
		expect(seqs).toEqual([...seqs.keys()]);
		// 第四轮: the lock FILE persists (it is never deleted), but the
		// CLI released the kernel lock — a fresh writer acquires it at once.
		const leftovers = readdirSync(join(home, "sessions")).filter((f) => f.endsWith(".lock"));
		expect(leftovers).toEqual(["e2e.lock"]);
		await new SessionStore(join(home, "sessions")).append("e2e", "post-exit", {
			seq: records.length,
			type: "stop",
			reason: "end_turn",
		});
	});

	it("faux chat supports at least two consecutive user turns in ONE process (F 组)", () => {
		const home = mkdtempSync(join(tmpdir(), "kiso-cli-"));
		const result = runCli(["chat", "twoturns"], "first question\nsecond question\nexit\n", { KISO_HOME: home });
		expect(result.status, result.stderr).toBe(0);
		// Two turns rendered, two honest terminals ("done").
		const doneCount = (result.stdout.match(/done/g) ?? []).length;
		expect(doneCount).toBe(2);
		// 八: the prompt is RE-ARMED after every turn — never type blind.
		expect((result.stdout.match(/you> /g) ?? []).length).toBeGreaterThanOrEqual(2);
	});

	it("八: a faux script exhausted mid-session exits NON-ZERO with a clear message, never status 0", () => {
		const home = mkdtempSync(join(tmpdir(), "kiso-cli-"));
		// The script declares 4 provider turns (the first user turn consumes
		// two — call + summary); the FOURTH user turn hits the empty stream —
		// an honest failure, not a silent status-0 provider error.
		const result = runCli(["chat", "exhaust"], "one\ntwo\nthree\nfour\nexit\n", { KISO_HOME: home });
		expect(result.status).toBe(1);
		expect(result.stdout + result.stderr).toContain("exhausted");
	});

	it("help exits cleanly", () => {
		const result = runCli(["help"], "", {});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("kiso chat");
	});
	it("P1-11: Ctrl+C during startup recovery does not swallow the next user input (real PTY)", async () => {
		const home = mkdtempSync(join(tmpdir(), "kiso-cli-"));
		// Seed a session with a PENDING approval so the startup recovery
		// pauses at a question.
		const store = new SessionStore(join(home, "sessions"));
		await store.append("prep", "r1", { seq: 0, type: "user_input", content: "go" });
		await store.append("prep", "r1", { seq: 1, type: "permission_requested", decisionId: "d-1", callId: "c1", name: "web_search", input: {} });
		store.closeAll();

		// A REAL PTY via python3's pty module (ISIG enabled): Ctrl+C at the
		// question (cancels it and aborts the recovery run), then a user
		// line, then exit. The post-cancellation line must become a NEW
		// turn — the dead question must not swallow it.
		const helper = `
import pty, os, sys, time, select
pid, fd = pty.fork()
if pid == 0:
    os.environ["KISO_HOME"] = ${JSON.stringify(home)}
    os.execvp("node", ["node", ${JSON.stringify(CLI)}, "chat", "prep"])
out = b""
def read_until(needle, timeout):
    global out
    end = time.time() + timeout
    while needle not in out and time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                out += os.read(fd, 4096)
            except OSError:
                break
    return needle in out
read_until(b"approve web_search", 15)   # the recovery question is up
os.write(fd, b"\\x03")                   # Ctrl+C: cancel the question, abort the run
time.sleep(0.8)
os.write(fd, b"hello\\n")                # the NEXT user input
processed = read_until(b"faux model", 15)  # it became a turn and was answered
os.write(fd, b"exit\\n")
time.sleep(1)
try:
    os.kill(pid, 15)
except ProcessLookupError:
    pass
sys.stdout.write(out.decode(errors="replace"))
sys.exit(0 if processed else 1)
`;
		const result = spawnSync("python3", ["-c", helper], { encoding: "utf8", timeout: 60_000 });
		expect(result.status, result.stdout.slice(-600)).toBe(0);
		// The line after the cancellation produced a real turn.
		expect(result.stdout).toContain("faux model");
	});
});

	it("B: tool summary lines and the status line appear in a real chat run", () => {
		const home = mkdtempSync(join(tmpdir(), "kiso-cli-"));
		const result = runCli(["chat", "bsum"], "hello\n/last\nexit\n", { KISO_HOME: home });
		expect(result.status, result.stderr).toBe(0);
		// The tool summary line: a list_dir completion with the root marker.
		expect(result.stdout).toContain("✓ list_dir (root)");
		// The status line after the terminal, with unknown usage rendered ?.
		expect(result.stdout).toMatch(/\[turn \d+ · in \? out \? · cache \? · ctx ~\d+%\]/);
		// /last printed the full input/output from the event stream.
		expect(result.stdout).toContain("--- list_dir input ---");
		expect(result.stdout).toContain("--- list_dir output ---");
	});
