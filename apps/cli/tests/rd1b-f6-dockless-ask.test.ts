/**
 * RD1B-F6 — a dock-less `ask_user` must not hang on input nobody sends.
 *
 * On a tty too small for the dock, `askView`'s fallback prints
 *
 *   ⚠ <question> — this terminal cannot show the option panel; the question is declined
 *
 * — a sentence in the past tense, describing a resolved state. The code
 * resolved nothing: askPanel called input.question() and waited for a
 * line, forever. Nothing in the environment has a reason to send that
 * line; the surface has just announced the interaction is over. So an
 * unattended run did not fail, it stopped, and stopped silently.
 *
 * That is what happened to RD-1B's c9-r2: the agent asked one question
 * (the apparent repeat was kiso's own 12-char header cap rejecting a
 * 13-char header, which the agent then corrected), and the run sat at
 * its deadline having started zero effect attempts.
 *
 * The fix makes the sentence true: with no dock there is no way to
 * present options, so the ask declines immediately and the model gets
 * an honest `declined` result to act on. The y/n fallback still serves
 * the views that genuinely take a yes or no — the uncertainty gate, the
 * trust prompt, the verify offer — which are unaffected here.
 *
 * The test sends NO INPUT AT ALL. That is the whole point: it passes
 * only if the run completes on its own.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, stripANSI } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** A ONE-row pty — rows < 4 is the dock-less branch, and the surface the
 *  RD-1 driver runs. Nothing is ever written to the child. */
const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, session, env, prompt, timeout):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execvp("node", ["node", cli, "chat", session])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 1, 80, 0, 0))
    full = b""
    sent = False
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            full += data
        if not sent and b"extensions:" in full:
            time.sleep(0.8)
            os.write(fd, prompt.encode() + b"\\r")
            sent = True
        # NO INPUT IS EVER SENT TO THE ASK. If the run needs one, it hangs.
        if b"RD1B-F6-CONTINUED" in full:
            break
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except Exception:
        pass
    sys.stdout.write(full.hex())
    sys.exit(0)
`;

function runUnattended(env: NodeJS.ProcessEnv, session: string, prompt: string): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-rd1bf6-pty-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(session)}, ${JSON.stringify(env)}, ${JSON.stringify(prompt)}, 25)
`;
	const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 45_000, env: process.env });
	return Buffer.from(out, "hex").toString("utf8");
}

function seededEnv(): { env: NodeJS.ProcessEnv; home: string; session: string } {
	const { env, dirs } = isolatedEnv();
	const dir = mkdtempSync(join(tmpdir(), "kiso-rd1bf6-cli-"));
	const script = join(dir, "faux.json");
	writeFileSync(
		script,
		JSON.stringify([
			{
				events: [
					{
						type: "tool_call_end",
						callId: "a1",
						name: "ask_user",
						input: { questions: [{ header: "bundler", question: "Which bundler should I use?", options: [{ label: "vite" }, { label: "webpack" }] }] },
					},
					{ type: "stop", reason: "tool_use" },
				],
			},
			{ events: [{ type: "text_delta", text: "RD1B-F6-CONTINUED" }, { type: "stop", reason: "end_turn" }] },
		]),
		"utf8",
	);
	mkdirSync(join(dirs.home, "sessions"), { recursive: true });
	return { env: { ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" }, home: dirs.home, session: "rd1bf6" };
}

describe("RD1B-F6 — a dock-less ask declines instead of waiting forever", () => {
	it("with NO input ever sent, the run continues past the ask", () => {
		const { env, home, session } = seededEnv();
		const screen = stripANSI(runUnattended(env, session, "set the project up"));

		// The defect: the surface said the question was declined and then
		// waited anyway, so an unattended run stopped here permanently.
		expect(screen).toContain("cannot show the option panel");
		expect(screen, "the run must proceed on its own — nothing sends that line").toContain("RD1B-F6-CONTINUED");

		// ...and the model must have been handed an honest refusal, not a
		// fabricated answer to a question no human ever saw.
		const rows = readFileSync(join(home, "sessions", `${session}.jsonl`), "utf8")
			.split("\n")
			.filter((l) => l.trim() !== "")
			.map((l) => JSON.parse(l) as { event: { type: string; name?: string; content?: unknown } });
		const result = rows.find((r) => r.event.type === "tool_result");
		expect(JSON.stringify(result?.event.content ?? "")).toContain("declined");
	}, 90_000);
});
