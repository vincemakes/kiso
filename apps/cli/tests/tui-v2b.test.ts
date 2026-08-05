/**
 * v2b — the bottom-anchored UI through the CLI's topmost entry, on a REAL
 * PTY with a real window size (the driver sets TIOCSWINSZ): the bottom
 * three rows exist (separator / live status bar / input line), the body
 * scrolls inside the DECSTBM region without eating the dock, an approval
 * takes over the status position and restores, a SIGWINCH rebuilds the
 * dock, and exit resets the scroll region (CSI r) so no broken terminal
 * is left behind.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, stripANSI } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** The python PTY driver: 24×80 window, feed (needle, text) pairs once,
 *  report the transcript. `winch` (optional) resizes + SIGWINCHs midway;
 *  `exitAfterWinch` (optional) types "exit" that many seconds AFTER the
 *  winch — a feed-triggered "exit" would land in the SAME poll iteration as
 *  the winch and tear the dock down before the signal arrived. */
const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, env, feeds, timeout, winch=None, winch_at=b"", exit_after_winch=None):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execvp("node", ["node", cli, "chat"])
    def winsize(rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    winsize(24, 80)
    out = b""
    full = b""
    fed = set()
    end = time.time() + timeout
    done = False
    winch_sent = False
    winch_time = None
    exit_sent = False
    while time.time() < end and not done:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                done = True
                break
            out += data
            full += data
            for i, (needle, text) in enumerate(feeds):
                if i not in fed and needle.encode() in full:
                    os.write(fd, text.encode())
                    fed.add(i)
        if winch is not None and not winch_sent and winch_at.encode() in full:
            winsize(*winch)
            os.kill(pid, signal.SIGWINCH)
            winch_sent = True
            winch_time = time.time()
        if winch_sent and not exit_sent and exit_after_winch is not None and time.time() - winch_time >= exit_after_winch:
            os.write(fd, b"exit\\n")
            exit_sent = True
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

function ptyRun(
	env: NodeJS.ProcessEnv,
	feeds: [string, string][],
	opts: { winch?: [number, number]; winchAt?: string; exitAfterWinch?: number; timeout?: number } = {},
): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-v2b-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const winch = opts.winch === undefined ? "None" : JSON.stringify(opts.winch);
	const exitAfter = opts.exitAfterWinch === undefined ? "None" : JSON.stringify(opts.exitAfterWinch);
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${opts.timeout ?? 40}, ${winch}, ${JSON.stringify(opts.winchAt ?? "")}, ${exitAfter})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
}

describe("TUI v2b (real PTY, 24×80)", () => {
	it("the dock exists — separator, live status bar, input line; the body scrolls without eating it; exit resets the scroll region", () => {
		const { env } = isolatedEnv();
		const out = ptyRun(env, [
			["you> ", "look around\n"],
			// "turn 2 · faux" — the status bar at the turn's terminal event —
			// only exists AFTER the turn completes, so "exit" cannot collide
			// with the first prompt (a "you> " needle would match there too
			// and close the readline mid-turn).
			["turn 2 · faux", "exit\n"],
		]);
		// The DECSTBM scroll region is applied at startup.
		expect(out).toContain("\x1b[1;21r"); // rows 1..21 (24 - 3)
		// The status bar carries session · model · [turn N · faux].
		const clean = stripANSI(out);
		expect(clean).toContain("· faux · [turn 2 · faux]");
		// The input line's blue prompt exists.
		expect(out).toContain("\x1b[38;5;75m");
		// P3 (审查): the synchronized-output SET is the DEC private form —
		// \x1b[?2026h — the bare \x1b[2026h is silently ignored by
		// terminals, so the anti-flicker never engages. Pinned here so the
		// byte assertion catches a regression the terminal transcripts
		// cannot.
		expect(out).toContain("\x1b[?2026h");
		expect(out).not.toContain("\x1b[2026h");
		// The body scrolls inside the region — the status bar survives a
		// long body (the status reappears AFTER the last body chunk).
		expect(clean.indexOf("· faux · [turn 2 · faux]")).toBeGreaterThan(clean.indexOf("done"));
		// v2b: the SENT line renders into the body (blue you> + content +
		// reset + pty-cooked newline, then the cursor RETURNS TO THE EDIT
		// POSITION — the drift fix; v2c the brick prompt ▌you> is 6 wide,
		// so the empty-line edit column is 7 — distinct from the input
		// row's prompt+line): the typed text must not vanish after Enter.
		expect(out).toContain("\x1b[38;5;75myou> look around\x1b[0m\r\n\x1b[24;7H");
		// Exit resets the scroll region (CSI r) — no broken terminal.
		expect(out).toContain("\x1b[r");
	}, 90_000);

	it("an approval takes over the status position and restores after the answer", () => {
		const { env, dirs } = isolatedEnv();
		// An extension tool at the ask tier: the human approves, the tool
		// executes and completes.
		writeFileSync(
			join(dirs.extensions, "asky.mjs"),
			`export default {
	name: "asky",
	approvals: [{ decide: () => ({ action: "ask" }) }], // the ask tier — the human decides
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
		const dir = mkdtempSync(join(tmpdir(), "kiso-v2b-"));
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
				["you> ", "go\n"],
				["approve asky_read", "y\n"],
				// The run continues after the approval — "turn 2 · faux" only
				// appears at the turn's terminal event, AFTER "the tour is
				// done". "you> " would match the FIRST prompt and close the
				// readline while the go-turn is still queued.
				["turn 2 · faux", "exit\n"],
			],
		);
		const clean = stripANSI(out);
		expect(clean).toContain("approve asky_read? (y/n)"); // the takeover question
		expect(clean).toContain("asky ok"); // the tool ran after the approval
		expect(clean).toContain("the tour is done");
		// The status bar returned after the question (the model name is back).
		expect(clean).toContain("· faux · [turn 2 · faux]");
	}, 90_000);

	it("/think prints the last FULL thinking block — the fold only hints", () => {
		const { env, dirs } = isolatedEnv();
		// One LONG block (> 100 chars): the dock folds it to one dim line
		// with the /think hint; /think then prints the FULL text from the
		// event stream.
		const dir = mkdtempSync(join(tmpdir(), "kiso-v2b-"));
		const script = join(dir, "faux.json");
		const longBlock = "A".repeat(100) + "SECRETTAIL";
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						{ type: "thinking", text: longBlock },
						{ type: "text_delta", text: "tour complete" },
						{ type: "stop", reason: "end_turn" },
					],
				},
			]),
			"utf8",
		);
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["you> ", "go\n"],
				// "tour complete" appears mid-run — the /think line queues on
				// the chain and prints AFTER the turn completes.
				["tour complete", "/think\n"],
				// The full block only appears in the /think output — a safe
				// needle that cannot collide with earlier content.
				["SECRETTAIL", "exit\n"],
			],
		);
		const clean = stripANSI(out);
		expect(clean).toContain(`…${"A".repeat(100)} (… /think shows full)`); // the folded line
		expect(clean).toContain("SECRETTAIL"); // the full block came back
		expect(clean).toContain("A".repeat(100)); // …head included
		expect(out).toContain("\x1b[r"); // clean exit
	}, 90_000);

	it("a SIGWINCH rebuilds the dock — the region is re-applied at the new height", () => {
		const { env } = isolatedEnv();
		const out = ptyRun(
			env,
			[["you> ", "look around\n"]],
			// The winch fires when "done" reaches the driver — the CLI is
			// back at the prompt by then, so the rebuild lands on a live
			// dock; "exit" is typed 0.5s AFTER the winch (a feed would land
			// in the same poll and tear the dock down first).
			{ winch: [30, 100], winchAt: "done", exitAfterWinch: 0.5 },
		);
		// The region is re-applied for the NEW height (30 - 3 = 27).
		expect(out).toContain("\x1b[1;27r");
		expect(out).toContain("\x1b[r"); // and reset at exit
	}, 90_000);
});
