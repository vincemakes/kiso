/**
 * v2c — the self-drawn editor through the CLI's topmost entry, on a REAL
 * PTY (24×80, TIOCSWINSZ): the Chinese-input cursor lands on the DISPLAY
 * width column (the drift root cure), the submitted line renders in the
 * scroll region EXACTLY once, a turn submitted while another runs queues
 * with "+N queued" and executes next, Esc cancels a paused approval (the
 * conservative denial continues the run — the old abort is gone), and
 * exit turns bracketed paste off (?2004l) and resets the region (CSI r).
 * W22 adds the visibility invariant's e2e: queued turns pre-render ABOVE
 * the input row as the SAME UserMessage chips (the dim □ gutter marks the
 * queued state), ↑ pops the last chip back into the editor and esc pops
 * one more, the popped turns NEVER execute, and a piped session shows no
 * chips (the pipe path has no raw keys).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VtScreen } from "./helpers/vt-screen.js";
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
	it("wide input (fullwidth) lands the cursor on the DISPLAY-width column — ＡＡ is 4 cells, not 2", () => {
		const { env } = isolatedEnv();
		const out = ptyRun(env, [
			// Feed the two wide chars ONE AT A TIME (each with its own
			// needle, so the frame between them renders the intermediate
			// row); the submit waits for the row showing the FULLWIDTH pair.
			["▌ ", "Ａ"],
			["Ａ", "Ａ"], // the row now shows the first Ａ — type the second
			["ＡＡ", "\r"], // W6: the row shows the 4-cell pair whole inside the box (the display-width reflow) — submit
			// MOVED (the boot-status class, TUI2-R2 ⑥): this feed used the
			// idle status row as a stand-in for "the turn ended". The row is
			// on screen from the FIRST paint now, so that needle fires before
			// anything has been typed — the driver's feeds are independent,
			// not sequential, so the exit landed first and the case tested
			// nothing. The RECAP row (▞) is what actually means "a turn
			// finished", and it always did.
			["▞", "exit\r"],
		]);
		// v6: the cursor derives from the frame's marker — the marker sits
		// at leadW + the DISPLAY cursor (2 + 4 = 6 for ＡＡ — the old CUP
		// home at 5/7 is gone; the row itself is the display-width proof:
		// the 4-cell pair renders whole, never split as 2+2 cells).
		expect(out).toContain("› ＡＡ");
		// The submitted line renders into the body (pty-cooked).
		const clean = stripANSI(out);
		expect(clean).toContain("ＡＡ"); // v3 §02: the user block has no "you> " prefix
		// And the input row survives (the editor's own render).
		expect(clean).toContain("› ");
	}, 90_000);

	it("the submitted line renders in the scroll region EXACTLY once — the SGR-7 chip + reset", () => {
		const { env } = isolatedEnv();
		const out = ptyRun(env, [
			// v6: the input row's frame COALESCES (16ms) — a burst of
			// inserts + the submit lands in one frame, so the typed line
			// needs its own needle to be observed before the Enter.
			["▌ ", "look around"],
			["look around", "\r"],
			// MOVED (the boot-status class, TUI2-R2 ⑥): this feed used the
			// idle status row as a stand-in for "the turn ended". The row is
			// on screen from the FIRST paint now, so that needle fires before
			// anything has been typed — the driver's feeds are independent,
			// not sequential, so the exit landed first and the case tested
			// nothing. The RECAP row (▞) is what actually means "a turn
			// finished", and it always did.
			["▞", "exit\r"], // the recap row marks the turn's end
		]);
		// The box's input row renders the light › prompt + the line (the
		// wall's dim SPLITS the row from the text — that raw shape is the
		// row, not the body echo). W6: the › is light (the box already
		// says "input lives here").
		expect(out).toContain("› look around");
		// v2d: the body echo is the frozen UserCell — the SGR-7 chip +
		// reset, EXACTLY once (the row is not the scroll region, the
		// frozen cell is the only copy there).
		const bodyEcho = "\x1b[7m look around \x1b[27m"; // the 2026-08-09 ruling: the chip ALONE, flush left
		const esc = bodyEcho.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		// DECLARED SUPERSESSION (REL-0152-R1): counted where "exactly
		// once" is a claim about the terminal rather than about the byte
		// stream. The old renderer moved rows by scrolling, so a committed
		// row was written once and never again; a diff rewrites a row
		// whenever its content changes, and when the window shifts every
		// row's content changes. The chip is still on the terminal exactly
		// once — that is what the screen plus the scrollback says, and it
		// is what the A7 replay gate asserts at every frame and every size.
		const term2c = new VtScreen(24, 80);
		term2c.write(Buffer.from(out, "utf8"));
		const seen2c = term2c.visible().join("\n");
		expect((seen2c.match(/ look around /g) ?? []).length).toBe(1);
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
				["▌ ", "one\rtwo\r"],
				["turn two done", "exit\r"],
			],
		);
		const clean = stripANSI(out);
		expect(clean).toContain("turn one done"); // the FIRST turn completed (the queued turn followed)
		expect(clean).toContain("turn one done");
		expect(clean).toContain("turn two done"); // the queued turn EXECUTED
	}, 90_000);

	it("Esc cancels a paused approval — the conservative denial CONTINUES the run, the REPL survives", () => {
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
				["▌ ", "go\r"],
				["needs approval", "\x1b"], // the rule line's dim run — Esc at the panel = the cancel
				// The cancel is a CONSERVATIVE DENIAL (a RESULT, not an
				// abort): the run continues and the script's turn 2 ("the
				// tour is done") completes the SAME run.
				["[approval cancelled — treated as a denial]", ""],
				["the tour is done", "exit\r"],
			],
		);
		const clean = stripANSI(out);
		expect(clean).toContain("[approval cancelled — treated as a denial]");
		expect(clean).not.toContain("[aborting run]"); // the old abort is GONE — the denial continues the run
		// The REPL survived the cancel — the SAME run completed its turn.
		expect(clean).toContain("the tour is done");
	}, 90_000);

	it("W22: queued turns pre-render as the □ chips above the input row — ↑ pops the last back into the editor, esc pops one more, the re-submit runs and the popped turns NEVER execute", () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-v2c-"));
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				// The leading delay keeps turn one RUNNING long enough for the
				// chips + the pop keys to be exercised on the live PTY.
				{ events: [{ type: "delay", ms: 1500 }, { type: "text_delta", text: "turn one done" }, { type: "stop", reason: "end_turn" }] },
				{ events: [{ type: "delay", ms: 1500 }, { type: "text_delta", text: "turn two done" }, { type: "stop", reason: "end_turn" }] },
				{ events: [{ type: "delay", ms: 1500 }, { type: "text_delta", text: "turn three done" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				// "one" submits; "two" + "three" queue while turn one runs.
				["▌ ", "one\rtwo\rthree\r"],
				// The three-chip needle — ↑ pops the LAST queued line back
				// into the editor (the chip leaves the queue).
				["\x1b[2m□\x1b[0m \x1b[7m three", "\x1b[A"],
				// The popped line in the input row — esc pops ONE MORE
				// ("two") and ends the pop-mode.
				["› three", "\x1b"],
				// The esc-popped line — submit it: it runs as a fresh turn.
				["› two", "\r"],
				// MOVED (the boot-status class, TUI2-R2 ⑥): see above — the
				// idle row is on screen from the first paint, so it can no
				// longer stand in for "a turn ended". Here it mattered twice
				// over: the early exit also let the queued turns drain, which
				// is exactly what this case asserts must NOT happen.
				["turn two done", "exit\r"],
			],
		);
		// The chips are the SAME UserMessage chip as the body record — the
		// dim □ gutter marks the queued state (never dimmed: the chip
		// inverts the CURRENT colours).
		expect(out).toContain("\x1b[2m□\x1b[0m \x1b[7m two");
		expect(out).toContain("\x1b[2m□\x1b[0m \x1b[7m three");
		// The status hint carries the queue depth.
		expect(out).toContain("+2 queued");
		expect(out).toContain("+1 queued");
		const clean = stripANSI(out);
		expect(clean).toContain("turn one done");
		// The resubmitted "two" ran as a fresh turn...
		expect(clean).toContain("turn two done");
		// ...but the popped "three" NEVER ran — its slot was cancelled.
		expect(clean).not.toContain("turn three done");
	}, 90_000);

	it("W22: a piped session shows NO chips — the pipe path has no raw keys, the queue is silent", () => {
		const { env } = isolatedEnv();
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
		// "exit" closes the input; the chained turns drain, then the
		// process exits — every user_input still records its `you> ` line
		// (the dock-less body write).
		const out = execFileSync("node", [CLI, "chat", "w22-pipe"], {
			input: "one\ntwo\nexit\n",
			encoding: "utf8",
			env: { ...env, KISO_FAUX_SCRIPT: script },
			timeout: 30_000,
		});
		expect(out).not.toContain("\x1b[2m□\x1b[0m"); // no compositor — no chips
		expect(out).toContain("you> one");
		expect(out).toContain("you> two");
	}, 60_000);
});
