/**
 * TUI v7 W19 — plan mode's product surface, through the CLI's topmost
 * entry on a REAL PTY (24×80) and in a PIPE:
 *
 *  1. the pinned deny row — `  write_file sub/out.txt (plan mode:
 *     read-only)`: the FULL call name, the target, the reason in the W4
 *     parentheses idiom, NO timing metadata (the call never ran — the
 *     claim the work order's gate asserts). The read runs; the denied
 *     call never asks (no "approve …? (y/n)" needle).
 *  2. the way-forward row — the plan turn ends with the recap idiom:
 *     `✦ plan ready · /mode default executes · /mode accept-edits
 *     auto-approves edits · ctx left ~N%` — the timing and tool-count
 *     parts drop (a plan turn's currency is the plan, not the tool
 *     count); /mode is the only exit.
 *  3. the idle posture — `▸ plan (read-only) · /mode to switch · …`.
 *  4. `/mode default` then executes normally — the shell call ASKS the
 *     human again and succeeds: `  shell echo hi (exit 0)`.
 *  5. the pipe path renders the same deny row, byte-clean (zero
 *     escapes).
 */

/**
 * DECLARED SUPERSESSION (R3g, 2026-08-28) — the recap is the turn's
 * COST (`✦ took 23s · in 12k · ctx left 41%`), not its work: the work
 * is said once, by the fold line, where it happened.
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
						{ type: "tool_call_end", callId: "w1", name: "write_file", input: { path: "sub/out.txt", content: "x", expectedRevision: "absent" } },
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
				["▌ ", "go\r"], // the brick — the startup paint is race-proof
				// the needles ride the POST-RESET text (the glyphs are SGR-
				// wrapped in the raw stream — "✦\x1b[0m plan ready" never
				// matches "✦ plan ready"; the post-reset run is contiguous)
				// R13: the fold is retired — the read's OWN card is what
				// says it ran, and its head row names the file.
				["read  a.ts", ""], // the read ran under plan
				["(plan mode: read-only", ""], // the pinned deny row's reason (A5: the · by <decider> tail rides INSIDE the parens — no trailing paren in the needle)
				["the survey is done.", ""], // the model's answer after the denial
				["plan ready", "/mode default\r"], // the way-forward row → the only exit
				["▸ default · /mode to switch", "go\r"], // turn 2 executes normally
				["needs approval", "y\r"], // the ask RESTORED under default — the rule line's dim run
				// NEEDLE MOVED (R9 P2 / D4): the head row no longer carries the
				// result, so the old needle never matched and the scenario spent
				// its whole 60s wall — a driver whose wait cannot match reports
				// as a product timeout. The outcome ROW is the moment now.
				["exit 0 · 1 line", "exit\r"], // the shell ran and settled
			],
			workdir,
		);
		const clean = stripANSI(out);

		// ① the pinned deny: the full call name + the target + the reason,
		// no timing metadata — and the read ran (its own W4 settled row:
		// `  read (3 lines, 0.0s)` — the interactive row carries the meta,
		// the target lives in the pipe's summary).
		// MOVED (R1.5 slice 5, the approval-attribution class — DECLARED
		// THIS ROUND): a POLICY verdict is ambient and silent; a HUMAN
		// verdict is what the row records. `approved by mode:*` was the
		// runtime's backfill for "no policy expressed an opinion", read by
		// a human as an attribution (VD-11).
		// DECLARED SUPERSESSION (R3i phase 3): the plan turn's read and its
		// denied write are ONE stretch, so they fold — and the fold names
		// the denial rather than leaving a row to be found. What a human
		// must see without pressing anything is unchanged and is asserted
		// below: WHICH call was refused and WHY. The settled row's own
		// shape (`  read  a.ts (0.0s) · N lines · ctrl+o`) is A4's claim
		// and is gated where it belongs, in compositor.test.ts.
		expect(clean).toContain("read  a.ts"); // the work it DID, on its own card
		expect(clean).not.toContain("wrote 1 file"); // ...and not the write it did not
		// MOVED (R1.5 slice 5, the approval-attribution class): a POLICY
		// denial keeps only its REASON — the reason is the answer to "why",
		// and mode:plan deciding it is the ambient default of plan mode.
		// MOVED (R13): the fold is retired, so the denial is back on the
		// denied call's OWN row, which says strictly more — the full call
		// name, the target, and the reason. The subject is unchanged: WHICH
		// call was refused, and WHY.
		expect(clean).toContain("sub/out.txt");
		expect(clean).toContain("plan mode: read-only"); // which call, and why
		expect(clean).not.toContain("by mode:plan");
		expect(clean).not.toContain("approve write_file"); // the denied call never asked
		expect(clean).not.toMatch(/plan mode: read-only, \d+\.\ds/); // no (0.0s) noise
		// ② the way-forward row: the recap idiom, the /mode hints as the
		// exits, the timing/tool parts dropped. W19: the FULL hints line is
		// CONTIGUOUS — the ctx-left segment dropped BEFORE the fold, so the
		// 79-col row never wraps at W=80 (a folded row would split "edits"
		// and break this very assertion); the ctx-left hint lives on the
		// status row's right side.
		expect(clean).toContain("✦ plan ready · /mode default executes · /mode accept-edits auto-approves edits");
		// ③ the idle posture.
		expect(clean).toContain("▸ plan (read-only) · /mode to switch");
		// ④ /mode default executes NORMALLY: the ask is back, the shell
		// succeeds, the recap is the ordinary shape (not plan-ready again).
		expect(clean).toContain("shell needs approval");
		// MOVED (R1.5 slice ⑤, the approval-attribution class): the human
		// answered this ask, and that is what the row records.
		// MOVED (R9 P2 / D4): the settled shell is a slab. The head row
		// carries the target (A4's fact, unchanged); the outcome row
		// carries the result, the timing and the attribution, in pin 4's
		// order.
		expect(clean).toContain("  shell echo hi");
		expect(clean).toMatch(/ {4}exit 0 · 1 line · \d+\.\ds · approved/);
		// R3g: the recap is the turn's COST now — its ordinary shape is
		// `✦ took Ns · …`, and what this case actually claims is that
		// turn 2 ended in that ordinary row rather than a second
		// plan-ready one (asserted below).
		expect(clean).toMatch(/✦ took \d+s · /);
		// never a SECOND way-forward row: the plan-ready row belongs to
		// turn 1 — every occurrence must PRECEDE the turn-2 answer (A8's
		// full draws repaint the settled rows, so the row's text repeats
		// across frames in the capture; the honest gate is POSITION — a
		// true second row would land after the answer).
		// DECLARED SUPERSESSION (REL-0152-R1): the FIRST appearance, not
		// the last. This reads position in the byte stream as time, which
		// is right — but a diffing renderer re-emits a row whenever its
		// content changes, and when the window shifts every row's does. So
		// "plan ready" appears again after "executed." without having
		// happened again, and lastIndexOf stops measuring time.
		//
		// When a row FIRST appears is still exactly when it happened, and
		// the ordering this case is about is unchanged.
		expect(clean.indexOf("plan ready")).toBeLessThan(clean.indexOf("executed."));
		expect(clean.indexOf("plan ready"), "the plan-ready row never appeared").toBeGreaterThanOrEqual(0);
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
						{ type: "tool_call_end", callId: "p1", name: "write_file", input: { path: "out.txt", content: "x", expectedRevision: "absent" } },
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
		// the claimed row, byte-plain. R2: the PIPE keeps its mark — the
		// ruling retired the tick from the interactive screen, where the
		// words already carried the outcome; on this path there is no
		// gutter, no colour and no metadata column, so the mark is the only
		// thing carrying the state.
		expect(run.stdout).toContain("\u2717 write_file out.txt (plan mode: read-only)");
		expect(run.stdout).not.toContain("\x1b["); // pipes are byte-plain — no ANSI
		// the full result still rides the folded body (never hide information).
		expect(run.stdout).toContain("[Permission denied] plan mode: read-only");
	}, 90_000);
});
