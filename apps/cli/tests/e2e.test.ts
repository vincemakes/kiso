/**
 * End-to-end: the BUILT CLI (plain node, no tsx) holds a durable session
 * across process boundaries — chat in one process, resume in another,
 * sessions listing, and the JSONL shows both runs. Requires the CLI build
 * (npm run check builds before testing).
 *
 * P2 (test hygiene): every real-process spawn runs against a FULLY isolated
 * environment (the shared helper — the host's ~/.kiso must never leak in)
 * with an explicit generous timeout: these tests measure correctness, not
 * speed.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SessionStore } from "@vincemakes/kiso-runtime";
import { readdirSync } from "node:fs";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

describe("kiso CLI (built artifact, faux mode)", () => {
	it("chat → resume in a new process → sessions listing → durable two-run history", async () => {
		const { env, dirs } = isolatedEnv();
		const home = dirs.home;
		const id = "e2e";

		// Process 1: interactive chat, one turn, exit.
		const first = runCli(["chat", id], env, { input: "look around\nexit\n" });
		expect(first.status, first.stderr).toBe(0);
		expect(first.stdout).toContain(`session ${id}`);
		expect(first.stdout).toContain("faux model");

		// Process 2: resume the same session from disk — a NEW process sees
		// the first run's history and completes another turn.
		const second = runCli(["resume", id, "continue"], env);
		expect(second.status, second.stderr).toBe(0);
		expect(second.stdout).toMatch(/▞ \d+s · \d+ tools?/); // the recap line ends the run (v3 — replaces the old status line)

		// Process 3: sessions lists the durable session.
		const sessions = runCli(["sessions"], env);
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
		// round 4: the lock FILE persists (it is never deleted), but the
		// CLI released the kernel lock — a fresh writer acquires it at once.
		const leftovers = readdirSync(join(home, "sessions")).filter((f) => f.endsWith(".lock"));
		expect(leftovers).toEqual(["e2e.lock"]);
		await new SessionStore(join(home, "sessions")).append("e2e", "post-exit", {
			seq: records.length,
			type: "stop",
			reason: "end_turn",
		});
	}, 60_000);

	it("faux chat supports at least two consecutive user turns in ONE process (F group)", () => {
		const { env } = isolatedEnv();
		const result = runCli(["chat", "twoturns"], env, { input: "first question\nsecond question\nexit\n" });
		expect(result.status, result.stderr).toBe(0);
		// Two turns rendered, two honest terminals.
		const terminalCount = (result.stdout.match(/▞ \d+s · \d+ tools?/g) ?? []).length;
		expect(terminalCount).toBe(2);
		// round 8: the prompt is RE-ARMED after every turn — never type blind.
		expect((result.stdout.match(/you> /g) ?? []).length).toBeGreaterThanOrEqual(2);
	}, 60_000);

	it("round 8: a faux script exhausted mid-session exits NON-ZERO with a clear message, never status 0", () => {
		const { env } = isolatedEnv();
		// The script declares 4 provider turns (the first user turn consumes
		// two — call + summary); the FOURTH user turn hits the empty stream —
		// an honest failure, not a silent status-0 provider error.
		const result = runCli(["chat", "exhaust"], env, { input: "one\ntwo\nthree\nfour\nexit\n" });
		expect(result.status).toBe(1);
		expect(result.stdout + result.stderr).toContain("exhausted");
	}, 60_000);

	it("help exits cleanly", () => {
		const { env } = isolatedEnv();
		const result = runCli(["help"], env);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("kiso chat");
	}, 60_000);

	it("P1-11: Ctrl+C during startup recovery does not swallow the next user input (real PTY)", async () => {
		const { env, dirs } = isolatedEnv();
		const home = dirs.home;
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
os.write(fd, b"hello\\r")                # the NEXT user input
processed = read_until(b"faux model", 15)  # it became a turn and was answered
os.write(fd, b"exit\\r")
time.sleep(1)
try:
    os.kill(pid, 15)
except ProcessLookupError:
    pass
sys.stdout.write(out.decode(errors="replace"))
sys.exit(0 if processed else 1)
`;
		const result = spawnSync("python3", ["-c", helper], { encoding: "utf8", timeout: 60_000, env });
		expect(result.status, result.stdout.slice(-600)).toBe(0);
		// The line after the cancellation produced a real turn.
		expect(result.stdout).toContain("faux model");
	}, 90_000);

	it("ruling #12: an approved-then-failed tool is a clean failure — zero uncertainty questions, the honest note rides the result", () => {
		const { env, dirs } = isolatedEnv();
		// The extension mirrors the MCP bridge: a tool with NO idempotent
		// declaration (unknown idempotency — the note applies), allowed by
		// its own policy so the call executes (the user's real case:
		// mcp__fs__directory_tree, ENOENT, receipt + ✗ both delivered).
		writeFileSync(
			join(dirs.extensions, "flaky.mjs"),
			`export default {
	name: "flaky",
	approvals: [{ decide: () => ({ action: "allow" }) }],
	tools: [{
		name: "flaky_read",
		description: "a read that fails",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: "ENOENT: no such file or directory", isError: true, errorKind: "fatal" }),
	}],
};
`,
			"utf8",
		);
		const dir = mkdtempSync(join(tmpdir(), "kiso-unc12-"));
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						{ type: "tool_call_end", callId: "c1", name: "flaky_read", input: {} },
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "text_delta", text: "the tour is done" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const res = runCli(["chat", "unc12"], { ...env, KISO_FAUX_SCRIPT: script }, { input: "go\nexit\n" });
		expect(res.status, res.stderr).toBe(0);
		expect(res.stdout).not.toContain("interrupted execution:"); // zero uncertainty questions (the fallback question's stable prefix — RD1B-F1 moved the question itself)
		expect(res.stdout).toContain("non-idempotent tool failed"); // the honest note rides the result
		expect(res.stdout).toContain("the tour is done"); // the run completes — the model may retry
	}, 60_000);

	it("B: tool summary lines and the status line appear in a real chat run", () => {
		const { env } = isolatedEnv();
		const result = runCli(["chat", "bsum"], env, { input: "hello\n/last\nexit\n" });
		expect(result.status, result.stderr).toBe(0);
		// The tool summary line: a list_dir completion with the root marker.
		expect(result.stdout).toContain("✓ list_dir (root)");
		// The recap line after the run — v3: ▞ seconds · tools · ctx left (faux
		// usage is unknown and omitted entirely).
		expect(result.stdout).toMatch(/▞ \d+s · \d+ tools?/);
		// /last printed the full input/output from the event stream.
		expect(result.stdout).toContain("--- list_dir input ---");
		expect(result.stdout).toContain("--- list_dir output ---");
	}, 60_000);
});
