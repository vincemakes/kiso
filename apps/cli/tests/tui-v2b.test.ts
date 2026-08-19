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
            os.write(fd, b"exit\\r")
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
				["▌ ", "look around\r"],
				["▸ default · /mode to switch · faux", "exit\r"], // v3 idle state marks the turn's end
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
		// UserCell (the SGR-7 chip + reset, printed at its region row — no
		// pty-cooked newline: the renderer positions the next row).
		// The input row's brick prompt+line is a DIFFERENT shape (the
		// reset splits the prompt from the text).
		const userEcho = "\x1b[7m look around \x1b[27m"; // the 2026-08-09 ruling: the chip ALONE, flush left (the ▍ rail + the indent retired)
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
				["▌ ", "go\r"],
				["needs approval", "y\r"], // the rule line's dim run — one contiguous RAW span
				// The run continues after the approval — "turn 2 · faux" only
				// appears at the turn's terminal event, AFTER "the tour is
				// done". "you> " would match the FIRST prompt and close the
				// readline while the go-turn is still queued.
				//
				// MOVED (EC-1 ⑦, the SCHEDULER-TIMING class — DECLARED THIS
				// ROUND): the exit feed used to ride the v3 idle status. Asks
				// now fire AFTER Turn Commit (ADR-0052 §6, ADR-0024 Amendment
				// 3), so the stream is already EXHAUSTED when the panel
				// mounts and the idle status paints while the question is
				// still on screen. The driver tests each needle against the
				// whole accumulated buffer, so that feed fired the moment the
				// idle line appeared — sending "exit" with the panel up and
				// killing the session before the human's verdict could
				// settle. The second turn's own text is the honest "the
				// approval was answered and the run moved on" marker. The
				// idle status is still ASSERTED below; it just no longer
				// TRIGGERS the exit.
				["the tour is done", "exit\r"],
			],
		);
		const clean = stripANSI(out);
		expect(clean).toContain("asky_read needs approval"); // the panel's rule line
		// W21: the panel superseded the ⏸ badge row — the approved cell
		// settles at the done form, and the [result] no longer flows into
		// the body (/last has it). A5: the decider tail (`· approved by
		// X`) rides ONLY the extension/mode-decided cells — the human's
		// panel decision needs no marker (the panel IS the record), so
		// "approved" never appears for the answered call.
		// MOVED (R1.5 slice ⑤, the approval-attribution class — DECLARED
		// THIS ROUND): the old rule was the exact inversion the walkthrough
		// objected to (VD-11) — a POLICY's ambient allow got a byline while
		// the human's own answer got none. It is the human's answer that is
		// worth the row: the panel is a record of the question, the row is
		// a record of the decision, and the two do not scroll together.
		// the verdict is a FACT in the W4 parentheses group; with no other
		// fact beside it the `·` separator would be dangling, so the row
		// reads "(approved, 0.0s)".
		expect(clean).toMatch(/\((?:[^()]* · )?approved, \d+\.\ds\)/);
		expect(clean).not.toContain("approved by");
		// MOVED (R1.5 slice 5, the R1 tool-cell suffix class): the line
		// count is stated EXACTLY ONCE (VD-6) and lives in the suffix, so
		// the parens carry the facts that are NOT the count — here the
		// human's own verdict.
		expect(clean).toMatch(/✓ asky_read  \(approved, \d+\.\ds\) · 1 line · ctrl\+r/); // the frozen done line (the empty target leaves the verb pad's double space)
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
				["▌ ", "go\r"],
				// "tour complete" appears mid-run — the /think line queues on
				// the chain and prints AFTER the turn completes.
				["tour complete", "/think\r"],
				// Exit only AFTER the /think output has rendered — the fold's
				// "· /think)" suffix ALSO appears mid-run (the v6 live fold:
				// the thinking cell renders its fold live, and the count
				// suffix rides the live form). Riding the suffix closed the
				// input before "tour complete" rendered, so the queued
				// "/think" landed on the closed editor and was dropped —
				// SECRETTAIL never printed (the 0.1.38 flake). SECRETTAIL
				// is the safe tail: the /think segment is done when it is
				// visible, and the LIVE fold (with the suffix) is already
				// in the stream, so the fold assert holds.
				["SECRETTAIL", "exit\r"],
			],
		);
		const clean = stripANSI(out);
		// #17: the fold is width-capped (W - 1 - suffix) so it fits its row —
		// the slice is 58 at 80 cols, NOT the old 100.
		expect(clean).toContain(`⋯${"A".repeat(80 - 1 - " (110 chars · /think)".length)} (110 chars · /think)`); // the folded line — W2: the ⋯ gutter
		expect(clean).toContain("SECRETTAIL"); // the full block came back
		// v6: the /think output is a raw cell — the compositor hard-folds it
		// at W (invariant ① — no soft-wraps), so the 110-A block arrives as
		// two rows; the CONTENT is all there (the fold only hints — the
		// count, not the contiguous span, is the contract now).
		expect((clean.match(/A/g) ?? []).length).toBeGreaterThanOrEqual(100);
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
			[["▌ ", "look around\r"]],
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
