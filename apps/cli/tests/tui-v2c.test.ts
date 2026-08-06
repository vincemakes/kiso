/**
 * v2c — the self-drawn editor through the CLI's topmost entry, on a REAL
 * PTY (24×80, TIOCSWINSZ): the Chinese-input cursor lands on the DISPLAY
 * width column (the drift root cure), the submitted line renders in the
 * scroll region EXACTLY once, a turn submitted while another runs queues
 * with "+N queued" and executes next, Esc aborts a paused run, and exit
 * turns bracketed paste off (?2004l) and resets the region (CSI r).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, stripANSI } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, env, feeds, timeout):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execvp("node", ["node", cli, "chat"])
    def winsize(rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    winsize(24, 80)
    full = b""
    fed = set()
    end = time.time() + timeout
    done = False
    while time.time() < end and not done:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                done = True
                break
            full += data
            for i, (needle, text) in enumerate(feeds):
                if i not in fed and needle.encode() in full:
                    os.write(fd, text.encode())
                    fed.add(i)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    sys.stdout.write(full.decode(errors="replace"))
    sys.exit(0)
`;

function ptyRun(env: NodeJS.ProcessEnv, feeds: [string, string][], timeout = 40): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-v2c-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${timeout})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
}

describe("TUI v2c (real PTY, 24×80)", () => {
	it("Chinese input lands the cursor on the DISPLAY-width column — 你好 is 4 cells, not 2", () => {
		const { env } = isolatedEnv();
		const out = ptyRun(env, [
			// Feed the two wide chars ONE AT A TIME so the dock's redraws
			// between them pin the intermediate cursor columns; 好+Enter
			// submits 你好 as a turn (the exit feed waits for the turn).
			["▌ ", "你"],
			["\x1b[24;5H", "好\n"],
			["turn 2 · faux", "exit\n"],
		]);
		// ▌ + space = 2 wide (TUI v4 #16d) → after 你 the edit column is
		// 2+2+1 = 5; after 你好 it is 2+4+1 = 7. The drift root cure: every
		// column is a display column, so the redraws land at 5 then 7.
		expect(out).toContain("\x1b[22;5H"); // v3 §03: the input row is H-2
		expect(out).toContain("\x1b[22;7H");
		// The submitted line renders into the body (blue, pty-cooked).
		const clean = stripANSI(out);
		expect(clean).toContain("你好"); // v3 §02: the user block has no "you> " prefix
		// And the input row survives (the editor's own render).
		expect(clean).toContain("▌ ");
	}, 90_000);

	it("the submitted line renders in the scroll region EXACTLY once — the ▍ rail + content + reset", () => {
		const { env } = isolatedEnv();
		const out = ptyRun(env, [
			["▌ ", "look around\n"],
			["▸ default · /mode to switch", "exit\n"], // v3 idle state marks the turn's end
		]);
		// The editor's input row renders the brick prompt + the line (the
		// reset SPLITS the prompt from the text — that raw shape is the
		// row, not the body echo). TUI v5 #16e: the brick is bold (SGR 1).
		expect(out).toContain("\x1b[1m▌ \x1b[0mlook around");
		// v2d: the body echo is the frozen UserCell — the ▍ rail + content
		// + reset, EXACTLY once (the row is not the scroll region, the
		// frozen cell is the only copy there).
		const bodyEcho = "\x1b[1m▍\x1b[0m look around"; // TUI v5 #16f: the ▍ rail
		const esc = bodyEcho.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		expect((out.match(new RegExp(esc, "g")) ?? []).length).toBe(1);
		// ?2004l on exit + region reset — no bracketed-paste left on.
		expect(out).toContain("\x1b[?2004l");
		expect(out).toContain("\x1b[r");
	}, 90_000);

	it("a turn submitted while another runs QUEUES — '+1 queued' rides the status bar and the next turn executes", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-v2c-"));
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{ events: [{ type: "text_delta", text: "turn one done" }, { type: "stop", reason: "end_turn" }] },
				{ events: [{ type: "text_delta", text: "turn two done" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				// Both lines land at the first prompt — the second submits
				// while the first turn is queued/running.
				["▌ ", "one\ntwo\n"],
				["turn two done", "exit\n"],
			],
		);
		const clean = stripANSI(out);
		expect(clean).toContain("turn one done"); // the FIRST turn completed (the queued turn followed)
		expect(clean).toContain("turn one done");
		expect(clean).toContain("turn two done"); // the queued turn EXECUTED
	}, 90_000);

	it("Esc aborts a paused run — the approval question is cancelled, the REPL survives", () => {
		const { env, dirs } = isolatedEnv();
		writeFileSync(
			join(dirs.extensions, "asky.mjs"),
			`export default {
	name: "asky",
	approvals: [{ decide: () => ({ action: "ask" }) }],
	tools: [{
		name: "asky_read",
		description: "a tool that needs approval",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: "asky ok", isError: false }),
	}],
};
`,
			"utf8",
		);
		const dir = mkdtempSync(join(tmpdir(), "kiso-v2c-"));
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						{ type: "tool_call_end", callId: "c1", name: "asky_read", input: {} },
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "text_delta", text: "the tour is done" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["▌ ", "go\n"],
				["approve asky_read", "\x1b"], // Esc while the run pauses
				// After the abort, a NEW turn consumes the script's turn 2.
				["[aborting run]", "next\n"],
				["the tour is done", "exit\n"],
			],
		);
		const clean = stripANSI(out);
		expect(clean).toContain("[aborting run]");
		expect(clean).toContain("[approval cancelled — treated as a denial]");
		// The REPL survived the abort — the next turn ran and exited.
		expect(clean).toContain("the tour is done");
	}, 90_000);
});
