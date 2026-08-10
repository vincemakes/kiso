/**
 * TUI v7 W19 — plan mode's product surface, through the CLI's topmost
 * entry on a REAL PTY (24×80) and in a PIPE:
 *
 *  1. the pinned deny row — `✗ write_file sub/out.txt (plan mode:
 *     read-only)`: the FULL call name, the target, the reason in the W4
 *     parentheses idiom, NO timing metadata (the call never ran — the
 *     claim the work order's gate asserts). The read runs; the denied
 *     call never asks (no "approve …? (y/n)" needle).
 *  2. the way-forward row — the plan turn ends with the recap idiom:
 *     `▞ plan ready · /mode default executes · /mode accept-edits
 *     auto-approves edits · ctx left ~N%` — the timing and tool-count
 *     parts drop (a plan turn's currency is the plan, not the tool
 *     count); /mode is the only exit.
 *  3. the idle posture — `▸ plan (read-only) · /mode to switch · …`.
 *  4. `/mode default` then executes normally — the shell call ASKS the
 *     human again and succeeds: `✓ shell echo hi (exit 0)`.
 *  5. the pipe path renders the same deny row, byte-clean (zero
 *     escapes).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** The ORDERED PTY driver — the while-loop consumes several needles that
 *  land in the SAME data batch (an if would stall forever once the child
 *  stops emitting). KISO_MODE comes from env_mode (overrides env). */
const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, env, feeds, workdir, timeout, env_mode):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        if env_mode:
            os.environ["KISO_MODE"] = env_mode
        os.chdir(workdir)
        os.execvp("node", ["node", cli, "chat", "planmode"])
    def winsize(rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    winsize(24, 80)
    full = b""
    idx = 0
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
            while idx < len(feeds) and feeds[idx][0].encode() in full:
                os.write(fd, feeds[idx][1].encode())
                idx += 1
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

function ptyRun(env: NodeJS.ProcessEnv, feeds: [string, string][], workdir: string, timeout = 60): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-planmode-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${JSON.stringify(workdir)}, ${timeout}, "plan")
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 120_000, env: process.env });
}

function stripANSI(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
}

describe("TUI v7 W19 — plan mode's product surface (real PTY, 24×80)", () => {
	it("the plan turn: reads run, the write renders the pinned deny (no ask ever), the way-forward row ends the turn; /mode default then executes normally", () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-planmode-"));
		const workdir = join(dir, "work");
		mkdirSync(workdir, { recursive: true });
		writeFileSync(join(workdir, "a.ts"), "line one\nline two\nline three\n", "utf8");
		const script = join(dir, "faux.json");
		// turn 1 (plan): read (allowed — runs) + write (DENIED pre-flight,
		// never asked) → text → end_turn. turn 2 (after /mode default):
		// shell (ASKED, human y) → text → end_turn.
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						{ type: "tool_call_end", callId: "r1", name: "read_file", input: { path: "a.ts" } },
						{ type: "tool_call_end", callId: "w1", name: "write_file", input: { path: "sub/out.txt", content: "x" } },
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "text_delta", text: "the survey is done." }, { type: "stop", reason: "end_turn" }] },
				{
					events: [
						{ type: "tool_call_end", callId: "s1", name: "shell", input: { command: "echo hi" } },
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "text_delta", text: "executed." }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["▌ ", "go\n"], // the brick — the startup paint is race-proof
				// the needles ride the POST-RESET text (the glyphs are SGR-
				// wrapped in the raw stream — "▞\x1b[0m plan ready" never
				// matches "▞ plan ready"; the post-reset run is contiguous)
				["read  a.ts (3 lines", ""], // the read ran under plan (A4: the target rides the settled row's head)
				["(plan mode: read-only", ""], // the pinned deny row's reason (A5: the · by <decider> tail rides INSIDE the parens — no trailing paren in the needle)
				["the survey is done.", ""], // the model's answer after the denial
				["plan ready", "/mode default\n"], // the way-forward row → the only exit
				["▸ default · /mode to switch", "go\n"], // turn 2 executes normally
				["needs approval", "y\n"], // the ask RESTORED under default — the rule line's dim run
				["shell echo hi (exit 0", "exit\n"], // the shell ran (A4: the target rides the settled row's head)
			],
			workdir,
		);
		const clean = stripANSI(out);

		// ① the pinned deny: the full call name + the target + the reason,
		// no timing metadata — and the read ran (its own W4 settled row:
		// `✓ read (3 lines, 0.0s)` — the interactive row carries the meta,
		// the target lives in the pipe's summary).
		expect(clean).toMatch(/✓ read  a\.ts \(\d+ lines · approved by mode:plan, \d+\.\ds\)/); // A4+A5: the target + the decider tail ride the settled head row (the verbCol's 5-char pad — the "read  5 files" double space)
		expect(clean).toContain("✗ write_file sub/out.txt (plan mode: read-only · by mode:plan)"); // the A5 deny tail names the decider inside the parens
		expect(clean).not.toContain("approve write_file"); // the denied call never asked
		expect(clean).not.toMatch(/✗ write_file sub\/out\.txt \(plan mode: read-only, \d+\.\ds\)/); // no (0.0s) noise
		// ② the way-forward row: the recap idiom, the /mode hints as the
		// exits, the timing/tool parts dropped. W19: the FULL hints line is
		// CONTIGUOUS — the ctx-left segment dropped BEFORE the fold, so the
		// 79-col row never wraps at W=80 (a folded row would split "edits"
		// and break this very assertion); the ctx-left hint lives on the
		// status row's right side.
		expect(clean).toContain("▞ plan ready · /mode default executes · /mode accept-edits auto-approves edits");
		// ③ the idle posture.
		expect(clean).toContain("▸ plan (read-only) · /mode to switch");
		// ④ /mode default executes NORMALLY: the ask is back, the shell
		// succeeds, the recap is the ordinary shape (not plan-ready again).
		expect(clean).toContain("shell needs approval");
		expect(clean).toMatch(/✓ shell echo hi \(exit 0, \d+\.\ds\)/); // A4: the target rides the settled row's head
		expect(clean).toContain("1 tool");
		// never a SECOND way-forward row: the plan-ready row belongs to
		// turn 1 — every occurrence must PRECEDE the turn-2 answer (A8's
		// full draws repaint the settled rows, so the row's text repeats
		// across frames in the capture; the honest gate is POSITION — a
		// true second row would land after the answer).
		expect(clean.lastIndexOf("plan ready")).toBeLessThan(clean.indexOf("executed."));
	}, 120_000);

	it("the pipe path prints the same deny row, byte-clean (no escapes)", () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-planmode-"));
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						{ type: "tool_call_end", callId: "p1", name: "write_file", input: { path: "out.txt", content: "x" } },
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "text_delta", text: "pipe done" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const run = runCli(["chat", "planpipe"], { ...env, KISO_MODE: "plan", KISO_FAUX_SCRIPT: script }, {
			input: "go\nexit\n",
			timeout: 60_000,
		});
		expect(run.status).toBe(0);
		// the claimed row, byte-plain — the SAME shape the PTY paints.
		expect(run.stdout).toContain("✗ write_file out.txt (plan mode: read-only)");
		expect(run.stdout).not.toContain("\x1b["); // pipes are byte-plain — no ANSI
		// the full result still rides the folded body (never hide information).
		expect(run.stdout).toContain("[Permission denied] plan mode: read-only");
	}, 90_000);
});
