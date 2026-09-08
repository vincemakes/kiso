/**
 * The dock-less fallback prompt's refusal grammar on the REAL input path
 * (LH-1 ruling 2026-09-08 — refuse with a reason and continue is the default
 * across arms; the surface a piped or 0-row leg drives is this one):
 *
 *   `n <reason>`  → permission_decided denied WITH the reason; the reason is
 *                   the tool result the model sees; the model's next turn
 *                   runs; the run ends `completed`
 *   bare `n`      → denied without a reason; the run ABORTS; the next call
 *                   never happens (unchanged behaviour)
 *   EOF at the prompt → nothing is approved, nothing executes, the process
 *                   exits — a cancel is never read as continue
 *
 * A 0-row pty (rows < 4) so the CLI takes the dock-less fallback path; the
 * model is a faux script (two shell calls, then end_turn); mode `default`
 * so shell asks.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { SessionStore } from "@vincemakes/kiso-runtime";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, env, feeds, workdir, timeout, session):
    pid, fd = pty.fork()
    if pid == 0:
        try:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 0, 120, 0, 0))
        except OSError:
            pass
        os.environ.update(env)
        os.chdir(workdir)
        os.execvp("node", ["node", cli, "chat", session])
    full = b""
    idx = 0
    pos = 0  # needles are CONSUMED: the next one is searched only after the last match
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            full += data
            while idx < len(feeds):
                at = full.find(feeds[idx][0].encode(), pos)
                if at < 0:
                    break
                pos = at + len(feeds[idx][0].encode())
                os.write(fd, feeds[idx][1].encode())
                idx += 1
        else:
            try:
                p, _ = os.waitpid(pid, os.WNOHANG)
                if p:
                    break
            except ChildProcessError:
                break
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    sys.stdout.write(full.decode(errors="replace"))
`;

const SCRIPT = [
	{ events: [{ type: "text_delta", text: "first" }, { type: "tool_call_end", callId: "c1", name: "shell", input: { command: "echo one" } }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "second" }, { type: "tool_call_end", callId: "c2", name: "shell", input: { command: "echo two" } }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "done" }, { type: "stop", reason: "end_turn" }] },
];

function run(feeds: [string, string][], session: string, timeout = 12) {
	const { env } = isolatedEnv();
	const dir = mkdtempSync(join(tmpdir(), "kiso-fallback-"));
	const workdir = join(dir, "work");
	mkdirSync(workdir, { recursive: true });
	writeFileSync(join(dir, "faux.json"), JSON.stringify(SCRIPT), "utf8");
	writeFileSync(join(dir, "driver.py"), PTY_DRIVER, "utf8");
	const childEnv = { ...env, KISO_FAUX_SCRIPT: join(dir, "faux.json"), KISO_MODE: "default", TERM: "dumb", KISO_NO_UPDATE_CHECK: "1" };
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(dir, "driver.py"))}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(childEnv)}, ${JSON.stringify(feeds)}, ${JSON.stringify(workdir)}, ${timeout}, ${JSON.stringify(session)})
`;
	const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 60_000, env: process.env });
	const events = new SessionStore(join(env.KISO_HOME!, "sessions")).load(session).map((r) => r.event) as unknown as Array<Record<string, unknown> & { type: string }>;
	return { out, events };
}

const ofCall = (events: Array<Record<string, unknown> & { type: string }>, callId: string, type: string) => events.filter((e) => e.type === type && e.callId === callId);

describe("the dock-less fallback prompt: refuse with a reason and continue (real 0-row pty)", () => {
	it("`n <reason>`: denied WITH the reason, the reason is the model's tool result, the next call runs, the run completes", () => {
		const { out, events } = run(
			[
				["extensions:", "go\r"],
				["approve shell? (y/n)", "n the file is outside the workspace\r"],
				["approve shell? (y/n)", "y\r"],
				["you> ", "\x04"],
			],
			"reason",
		);
		const tail = out.slice(-600);
		const decided = ofCall(events, "c1", "permission_decided");
		expect(decided, tail).toHaveLength(1);
		expect(decided[0]).toMatchObject({ decision: "denied", reason: "the file is outside the workspace" });
		const result = ofCall(events, "c1", "tool_result");
		expect(result).toHaveLength(1);
		expect(JSON.stringify(result[0])).toContain("the file is outside the workspace");
		expect(ofCall(events, "c1", "tool_execution_started")).toHaveLength(0);
		// the model saw the refusal and went on: its next turn's call ran
		expect(ofCall(events, "c2", "tool_call_end"), tail).toHaveLength(1);
		expect(ofCall(events, "c2", "permission_decided")[0], tail).toMatchObject({ decision: "approved" });
		expect(ofCall(events, "c2", "tool_execution_succeeded")).toHaveLength(1);
		const terminal = events.filter((e) => e.type === "terminal");
		expect(terminal, tail).toHaveLength(1);
		expect((terminal[0] as { outcome?: { kind?: string } }).outcome?.kind, tail).toBe("completed");
	}, 90_000);

	it("a bare `n`: denied without a reason, the run aborts, the next call never happens (unchanged)", () => {
		const { events } = run(
			[
				["extensions:", "go\r"],
				["approve shell? (y/n)", "n\r"],
				["you> ", "\x04"],
			],
			"bare",
		);
		const decided = ofCall(events, "c1", "permission_decided");
		expect(decided).toHaveLength(1);
		// the bare denial carries the CLI's default text, never words of the human's
		expect(decided[0]).toMatchObject({ decision: "denied", reason: "denied by user" });
		expect(ofCall(events, "c1", "tool_execution_started")).toHaveLength(0);
		expect(ofCall(events, "c2", "tool_call_end")).toHaveLength(0);
		const terminal = events.filter((e) => e.type === "terminal");
		expect(terminal).toHaveLength(1);
		expect((terminal[0] as { outcome?: { kind?: string } }).outcome?.kind).toBe("aborted");
	}, 90_000);

	it("EOF at the prompt: nothing approved, nothing executed, the process exits — a cancel is never read as continue", () => {
		const { out, events } = run(
			[
				["extensions:", "go\r"],
				["approve shell? (y/n)", "\x04"],
			],
			"eof",
			8,
		);
		expect(events.filter((e) => e.type === "permission_decided" && e.decision === "approved")).toHaveLength(0);
		expect(ofCall(events, "c1", "tool_execution_started")).toHaveLength(0);
		expect(ofCall(events, "c2", "tool_call_end")).toHaveLength(0);
		expect(out.length).toBeGreaterThan(0);
	}, 90_000);
});
