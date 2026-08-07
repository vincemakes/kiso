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
		// A TEXT-ONLY script — a tool's execution runs PARALLEL to the event
		// stream (ADR-0024), so the default faux script's tool result (and
		// the second turn after it) races the driver's exit: under load the
		// process exits before the tool completes and the response is lost.
		// This gate is about the dock/body bytes, not the tool lifecycle.
		const dir = mkdtempSync(join(tmpdir(), "kiso-v2b-"));
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						{ type: "text_delta", text: "I see the workspace. What would you like me to inspect or change?" },
						{ type: "stop", reason: "end_turn" },
					],
				},
			]),
			"utf8",
		);
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["▌ ", "look around\n"],
				["▸ default · /mode to switch · faux", "exit\n"], // v3 idle state marks the turn's end
			],
		);
		// #13 (P1), v2d-B: NO DECSTBM — the body scrolls with plain LF so
		// frozen lines enter the native scrollback deterministically. The
		// dock pins the bottom three rows by redrawing after every scroll.
		expect(out).not.toContain("\x1b[1;21r");
		// The status bar carries session · model · [turn N · faux].
		const clean = stripANSI(out);
		expect(clean).toContain("▸ default · /mode to switch · faux"); // v3 idle state
		// The input line's bold prompt exists (TUI v5 #16e: SGR 1).
		expect(out).toContain("\x1b[1m");
		expect(out).not.toContain("\x1b[38;5;75m");
		// P3 (review): the synchronized-output SET is the DEC private form —
		// \x1b[?2026h — the bare \x1b[2026h is silently ignored by
		// terminals, so the anti-flicker never engages. Pinned here so the
		// byte assertion catches a regression the terminal transcripts
		// cannot.
		expect(out).toContain("\x1b[?2026h");
		expect(out).not.toContain("\x1b[2026h");
		// The body scrolls inside the region — the turn's text AND the
		// live status bar both survive (v2d frames coalesce, so the raw
		// ordering between them is not pinned — the presence is).
		expect(clean).toContain("inspect or change?");
		expect(clean).toContain("▸ default · /mode to switch · faux"); // v3 idle state
		// v2d: the SENT line renders into the body EXACTLY once — a frozen
		// UserCell (the ▍ rail + content + reset, printed at its region row
		// — no pty-cooked newline: the renderer positions the next row).
		// The input row's brick prompt+line is a DIFFERENT shape (the
		// reset splits the prompt from the text).
		const userEcho = "\x1b[1m▍\x1b[0m look around"; // TUI v5 #16f: the ▍ rail, no "you> " prefix
		expect(out).toContain(userEcho);
		expect((out.match(new RegExp(userEcho.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length).toBe(1);
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
				["▌ ", "go\n"],
				["approve asky_read", "y\n"],
				// The run continues after the approval — "turn 2 · faux" only
				// appears at the turn's terminal event, AFTER "the tour is
				// done". "you> " would match the FIRST prompt and close the
				// readline while the go-turn is still queued.
				["▸ default · /mode to switch · faux", "exit\n"], // v3 idle state marks the turn's end
			],
		);
		const clean = stripANSI(out);
		expect(clean).toContain("approve asky_read? (y/n)"); // the takeover question
		// v2d: the ToolCell carries the ⏸ badge and freezes at the done
		// form — the [result] no longer flows into the body (/last has it).
		expect(clean).toContain("→ asky_read {} ⏸"); // the pending badge
		expect(clean).toContain("✓ asky_read ({}, "); // the frozen done line
		expect(clean).not.toContain("asky ok"); // the full result stays out of the stream
		expect(clean).toContain("the tour is done");
		// The status bar returned after the question (the model name is back).
		expect(clean).toContain("▸ default · /mode to switch · faux"); // v3 idle state
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
				["▌ ", "go\n"],
				// "tour complete" appears mid-run — the /think line queues on
				// the chain and prints AFTER the turn completes.
				["tour complete", "/think\n"],
				// The fold's own suffix — exit only AFTER the fold's freeze
				// frame has rendered (the real-LF commit writes more bytes
				// per line than the old CUP pre-fill, so the freeze frame
				// can trail the /think output; exiting on SECRETTAIL would
				// kill the process before the fold hits the screen).
				["· /think)", "exit\n"],
			],
		);
		const clean = stripANSI(out);
		// #17: the fold is width-capped (W - 1 - suffix) so it fits its row —
		// the slice is 58 at 80 cols, NOT the old 100.
		expect(clean).toContain(`…${"A".repeat(80 - 1 - " (110 chars · /think)".length)} (110 chars · /think)`); // the folded line (v3 wording)
		expect(clean).toContain("SECRETTAIL"); // the full block came back
		expect(clean).toContain("A".repeat(100)); // …head included
		expect(out).toContain("\x1b[r"); // clean exit
	}, 90_000);

	it("a SIGWINCH rebuilds the dock — the region is re-applied at the new height", () => {
		const { env } = isolatedEnv();
		// A TEXT-ONLY script — the default faux script's tool executes
		// PARALLEL to the event stream (ADR-0024); its response can be lost
		// when the process exits under load, and the winch needle would
		// never match. This gate is about the dock rebuild bytes.
		const dir = mkdtempSync(join(tmpdir(), "kiso-v2b-"));
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						{ type: "text_delta", text: "I see the workspace. What would you like me to inspect or change?" },
						{ type: "stop", reason: "end_turn" },
					],
				},
			]),
			"utf8",
		);
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[["▌ ", "look around\n"]],
			// The winch fires when the turn's text reaches the driver — the
			// CLI is back at the prompt by then, so the rebuild lands on a
			// live dock; "exit" is typed 0.5s AFTER the winch (a feed would
			// land in the same poll and tear the dock down first).
			{ winch: [30, 100], winchAt: "inspect or change", exitAfterWinch: 0.5 },
		);
		// #13 (P1), v2d-B: no scroll region to re-apply — the resize just
		// recomputes the dock rows; the separator re-renders at the new
		// width (100).
		expect(out).not.toContain("\x1b[1;27r");
		expect(out).toContain("\x1b[28;1H"); // the new H-2 = 30 - 2
		expect(out).toContain("\x1b[r"); // and reset at exit
	}, 90_000);
});
