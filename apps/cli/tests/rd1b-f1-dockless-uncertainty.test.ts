/**
 * RD1B-F1 — the dock-less uncertainty resolution, BOTH directions.
 *
 * RD-1B ran the frozen C3 scenario (the classic double-deploy trap)
 * twice against the shipped 0.15.1 CLI and it failed both runs. The
 * benchmark's human surrogate was doing exactly what the frozen
 * protocol demands — answering from the observable workspace truth,
 * with deploy-output.txt on disk — and the effect ran a second time.
 *
 * The cause was this surface. The dock-less fallback asked a STATE
 * question ("did it apply?"); askPanel maps `y` to `allow`, and
 * resolveUncertains maps `allow` to `rerun`. So the TRUTHFUL answer to
 * "did it apply?" — yes — re-ran the effect that had already applied.
 * The other direction lost the work.
 *
 * The dock path was never inverted (its rows are actions: "rerun it" /
 * "abandon it"), which is why nothing caught this: the bench runs a
 * 0-row tty, the only surface where the fallback question is the whole
 * interface. These two cases pin the dock-less path in BOTH directions,
 * against the durable log rather than the screen — the screen is what
 * lied.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, stripANSI } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** A ONE-row pty: rows < 4 is the dock-less branch — askPanel prints the
 *  fallback question and reads a y/n line. This is the bench's surface. */
const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, session, env, answer, timeout, grace):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execvp("node", ["node", cli, "resume", session])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 1, 80, 0, 0))
    full = b""
    sent = False
    end = time.time() + timeout
    settled = None
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
        if not sent and b"(y)es" in full:
            time.sleep(0.3)
            os.write(fd, answer.encode() + b"\\r")
            sent = True
            settled = time.time()
        if settled is not None and time.time() - settled >= grace:
            break
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    sys.stdout.write(full.hex())
    sys.exit(0)
`;

function ptyAnswer(env: NodeJS.ProcessEnv, session: string, answer: string): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-rd1bf1-pty-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(session)}, ${JSON.stringify(env)}, ${JSON.stringify(answer)}, 25, 3)
`;
	const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 40_000, env: process.env });
	return Buffer.from(out, "hex").toString("utf8");
}

/** The kill -9 shape RD-1B's C3 leaves: the call is durable, the
 *  execution STARTED, no receipt ever landed, the run never terminated. */
function seedKilledMidExecution(home: string, id: string): void {
	const dir = join(home, "sessions");
	mkdirSync(dir, { recursive: true });
	let seq = 0;
	const lines: string[] = [];
	const push = (event: Record<string, unknown>): void => {
		lines.push(JSON.stringify({ runId: "runA", ts: seq, event: { ...event, seq } }));
		seq += 1;
	};
	push({ type: "user_input", content: "deploy it" });
	push({ type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "kiso.json" } });
	push({ type: "stop", reason: "tool_use" });
	push({ type: "tool_execution_started", callId: "c1", invocationSeq: 1, name: "read_file", input: { path: "kiso.json" }, executionId: "ex-3" });
	writeFileSync(join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

/** What the durable log RECORDED — the only witness that outlives the
 *  screen, and the one the benchmark's scorer reads. */
function resolutionOf(home: string, id: string): string | undefined {
	const rows = readFileSync(join(home, "sessions", `${id}.jsonl`), "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l) as { event: { type: string; resolution?: string } });
	return rows.find((r) => r.event.type === "tool_execution_resolved")?.event.resolution;
}

function seededEnv(): { env: NodeJS.ProcessEnv; home: string; session: string } {
	const { env, dirs } = isolatedEnv();
	const dir = mkdtempSync(join(tmpdir(), "kiso-rd1bf1-cli-"));
	const script = join(dir, "faux.json");
	writeFileSync(script, JSON.stringify([{ events: [{ type: "text_delta", text: "resume settled" }, { type: "stop", reason: "end_turn" }] }]), "utf8");
	const session = "rd1bf1";
	seedKilledMidExecution(dirs.home, session);
	return { env: { ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" }, home: dirs.home, session };
}

describe("RD1B-F1 — the dock-less uncertainty question, both directions", () => {
	it("`y` reruns — and the question ASKED is the action y performs, not the state", () => {
		const { env, home, session } = seededEnv();
		const screen = stripANSI(ptyAnswer(env, session, "y"));

		// The defect, stated as the benchmark met it: a human who reads the
		// workspace and answers the STATE question truthfully double-deploys.
		// The question must therefore name the ACTION.
		expect(screen).toContain("rerun it?");
		expect(screen).not.toContain("did it apply?");

		expect(resolutionOf(home, session)).toBe("rerun");
	}, 60_000);

	it("`n` abandons — the opposite answer records the opposite resolution", () => {
		const { env, home, session } = seededEnv();
		stripANSI(ptyAnswer(env, session, "n"));
		expect(resolutionOf(home, session)).toBe("abandoned");
	}, 60_000);
});
