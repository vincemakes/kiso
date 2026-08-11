/**
 * TUI v4 #16 — the resize-storm gate (real PTY, real SIGWINCH):
 *
 * (1) #16a resize zero-push: after one turn completes, 5× TIOCSWINSZ (wide/
 *   narrow alternating) fire 0.5s apart. The SIGWINCH path must obey the
 *   #14 invariant — redraws are CUP in-place overwrites ONLY: ZERO real
 *   LF during the storm, the separator count in the ANSI-stripped text
 *   does NOT grow (a LF-pushing redraw would add newline-separated
 *   separator rows — the dashed-line pileup the user saw when dragging), and the
 *   model's response text appears EXACTLY once (no re-render duplicates).
 * ② #16b ESC integrity: the banner and the recap keep their SGR — the
 *   stripped text must not contain "[2m"/"[0m"/"[38;5" literals (the
 *   pre-fix code stripped the ESC at the raw cell, leaving literal SGR
 *   text on screen — the mojibake). The storm runs on a session WITH the
 *   banner, so both are covered.
 * ③ #16f theme (v5): the user block is the SGR-7 chip alone (the
 *   2026-08-09 ruling retired the ▍ rail), never the fixed 48;5;237
 *   background.
 * ④ #16d input row (W6): the box with the light › prompt — no "you>" text.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { VtScreen } from "./helpers/vt-screen.js";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** The storm driver: 24×80; feeds on needles; after the turn completes
 *  (the IDLE status "▸ default" — the dock's idle state only exists post-
 *  turn), 5 winches (120/60/120/60/100 cols) at 0.5s intervals; then exit.
 *  The transcript is the full byte stream. */
const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, env, feeds, timeout, cols=80, sizes=None):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execvp("node", ["node", cli, "chat"])
    def winsize(rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    winsize(24, cols)
    full = b""
    fed = set()
    end = time.time() + timeout
    done = False
    if sizes is None:
        sizes = [(24,120),(24,60),(24,120),(24,60),(24,100)]
    fired = 0
    storm_at = None
    exit_sent = False
    crashed = False
    while time.time() < end and not done:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                # EOF before the exit feed = the child died on its own —
                # the invariant-① crash class. A normal end (the exit feed
                # written) is NOT a crash.
                if not exit_sent:
                    crashed = True
                done = True
                break
            full += data
            for i, (needle, text) in enumerate(feeds):
                if i not in fed and needle.encode() in full:
                    os.write(fd, text.encode())
                    fed.add(i)
        # The window starts AFTER the recap's freeze frame — the idle dock
        # redraw lands before the body's 16ms frame commits the frozen
        # cells (each real-LF scroll writes a LF; the window must not
        # count them). The recap "▞ 0s" only exists once the freeze frame
        # has written — the turn is fully frozen by then.
        if storm_at is None and "0 tools".encode() in full:
            storm_at = time.time()
        if storm_at is not None and fired < len(sizes) and time.time() - storm_at >= 0.5 * (fired + 1):
            winsize(*sizes[fired])
            os.kill(pid, signal.SIGWINCH)
            fired += 1
        if storm_at is not None and not exit_sent and time.time() - storm_at >= (0.5 * (len(sizes) + 1) if len(sizes) else 1.0):
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
    sys.stdout.write(("CRASHED=1\\n" if crashed else "ALIVE=1\\n") + full.decode(errors="replace"))
`;

function stormRun(env: NodeJS.ProcessEnv, feeds: [string, string][], timeout = 45, cols = 80, sizes: [number, number][] | null = null): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-v4-storm-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	// `sizes` null → the python default (the 5 winches); [] → no winches.
	// JSON.stringify(null) would emit the python-invalid literal `null`,
	// so the arg is omitted entirely.
	const sizesArg = sizes === null ? "" : `, ${JSON.stringify(sizes)}`;
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${timeout}, ${cols}${sizesArg})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
}

function stripANSI(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
}

describe("TUI v4 #16 — the resize-storm gate (real PTY, 24×80)", () => {
	it("zero LF + stable separators + response exactly once + no ESC residue + the SGR-7 chip user block + the box › input row", () => {
		const { env } = isolatedEnv();
		// A TEXT-ONLY script — the default faux script's tool executes
		// PARALLEL to the event stream (ADR-0024), so its result (and the
		// response after it) races the storm driver's time-based exit:
		// under load the process exits before the tool completes and the
		// response is lost. This gate is about the resize storm bytes.
		const dir = mkdtempSync(join(tmpdir(), "kiso-v4-storm-"));
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						// the ≤100 thinking — the SHORT-CIRCUIT branch was W-blind:
						// at the 60-col winch the raw line tripped invariant ① (the
						// crash still live on npm) — the fold must width-cut it.
						{ type: "thinking", text: "T".repeat(60) },
						// the CJK wide-char line — 30 × 2 cells — the display-width
						// fold at the narrow winches (a char-based cut would split it).
						{ type: "text_delta", text: "I see the workspace" + "\u4f60".repeat(30) },
						{ type: "stop", reason: "end_turn" },
					],
				},
			]),
			"utf8",
		);
		const out = stormRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["› ", "look around\n"], // #16d + W6: the box's light prompt alone (no "you> ")
			],
		);
		// the process SURVIVED the whole storm — the driver's leading marker
		// (the EOF before the exit feed = the invariant-① crash class)
		expect(out.startsWith("ALIVE=1\n")).toBe(true);

		require("node:fs").writeFileSync("/tmp/storm-test-transcript.txt", out);
		// The storm window: from the recap's freeze frame (the turn is
		// fully frozen — the idle dock redraw lands BEFORE the body's 16ms
		// frame commits the frozen cells, and those real-LF commits must
		// not count inside the window) to the exit.
		const stormAt = out.indexOf("0 tools");
		expect(stormAt).toBeGreaterThan(0);
		const storm = out.slice(stormAt);
		const clean = stripANSI(storm);

		// ① #16a: ZERO real LF during the storm — CUP in-place redraws only.
		// (The recap cell's trailing blank-line commit may land one LF
		// inside the window — the "0 tools" needle matches mid-line; that
		// LF is a FROZEN commit, not a storm redraw.)
		// R-D 0.1.45 re-baseline 1 → 2: the always-present built-in
		// extensions row makes the banner fold WIDTH-sensitive at the
		// storm's narrow winches (the mcp row truncates with its (+N)
		// marker at 60 cols), so the V6-1 resize re-paint — one bounded
		// empty-row LF each — fires twice inside the window. The screen
		// gates below (response exactly once, box top at most once,
		// separator count stable) still pin the visual state.
		expect(storm.split("\n").length - 1).toBeLessThanOrEqual(2);

		// ① #16a: the separator LINE count does NOT GROW beyond the
		// re-paint budget — a LF-pushed redraw would add newline-separated
		// separator rows (the dashed-line pileup); CUP in-place re-emissions
		// merge into the existing lines (the dock redraw writes no
		// newlines), so the newline-delimited line count is the faithful
		// proxy for the visual state. Whole transcript, before vs after
		// the storm.
		// R-D 0.1.45 re-baseline (equality → +4): the always-present
		// built-in extensions row makes the banner fold width-sensitive at
		// the narrow winches, so the V6-1 re-paint scrolls once per bounded
		// repaint (the LF budget above, ≤2) — each scroll orphans one box
		// generation in the newline-delimited stream (the in-place 0K
		// clear keeps the old rails counted as lines, the re-drawn box
		// adds a new generation: +2 per scroll). The screen never shows
		// the ghost — the emulator replay below pins it. The unbounded
		// pileup class (per-redraw scrolls — the original #16a drag) still
		// blows the +4 budget at 5 winches.
		const sepLines = (t: string): number => t.split("\n").filter((l) => l.includes("╭") || l.includes("╰")).length; // W6: the ╌ rows became the box rails
		const cleanAll = stripANSI(out);
		expect(sepLines(cleanAll)).toBeLessThanOrEqual(sepLines(cleanAll.slice(0, stormAt)) + 4);

		// ① #16a: the model's response text appears EXACTLY once on the
		// SCREEN — V6-1: the resize's first frame re-folds and re-paints
		// the committed content (the screen-state == frame-state rule),
		// so the STREAM carries the response at each resize; the SCREEN
		// must never duplicate it (the reflow ghost — the V6-1 class).
		// The emulator replay pins the screen-level invariant.
		{
			const emu = new VtScreen(24, 80);
			emu.write(Buffer.from(out, "utf8"));
			const grid = emu.visible();
			expect(grid.filter((l) => l.includes("I see the workspace")).length).toBe(1);
			// V6-3 + W6: the chrome — the box top at most ONCE (the exit's
			// chrome-clear may wipe it — the WALL, the duplicated rails the
			// reflow left behind, would exceed 1).
			expect(grid.filter((l) => l.includes("╭")).length).toBeLessThanOrEqual(1);
		}

		// ② #16b: no ESC residue — the banner's dim and the recap's blue
		// keep their ESCs (the pre-fix raw-cell re-escape stripped them,
		// leaving literal "[2m"/"[38;5;75m" text — the mojibake).
		expect(clean).not.toContain("[2m");
		expect(clean).not.toContain("[0m");
		expect(clean).not.toContain("[38;5");

		// ③ #16f: the user block is the SGR-7 chip alone, flush left (the
		// 2026-08-09 ruling retired the ▍ rail + the indent) — never the
		// fixed dark background.
		expect(out).toContain("\x1b[7m look around \x1b[27m");
		expect(out).not.toContain("\x1b[48;5;237m"); // the fixed dark background stays banned

		// ④ #16d/#16e + W6: the input row is the box with the light ›
		// prompt alone (no blue, no "you> ").
		expect(out).toContain("› ");
		expect(out).not.toContain("\x1b[38;5;75m");
		expect(out).not.toContain("›you> ");
	}, 90_000);

	it("TUI v5 #16g — the idle hint: right-aligned when it fits, CUT FIRST when the width is short", () => {
		const { env } = isolatedEnv();
		// Text-only — the default faux script's tool races the driver's
		// time-based exit under load (ADR-0024); this gate is about the
		// idle status row.
		const dir = mkdtempSync(join(tmpdir(), "kiso-v4-storm-"));
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						{ type: "text_delta", text: "I see the workspace" },
						{ type: "stop", reason: "end_turn" },
					],
				},
			]),
			"utf8",
		);
		// 80 cols: the idle status (~50 cells) + the hint (23) fit — the
		// hint rides the status row, dim, right-aligned (the pad fills
		// between them; the dim span closes AFTER the hint).
		const wide = stormRun({ ...env, KISO_FAUX_SCRIPT: script }, [["› ", "look around\n"]], 30);
		expect(wide).toContain("/ commands · ↑ history");
		// 50 cols: status + hint = 73 > 50 → the HINT is cut — the status
		// itself is never truncated for it. The idle row's dim span ends
		// IMMEDIATELY after the status (the hint, had it fit, would sit
		// between the status and the reset).
		const narrow = stormRun({ ...env, KISO_FAUX_SCRIPT: script }, [["› ", "look around\n"]], 30, 50, []);
		// v6 invariant ①: the status itself must fit W — at 50 cols the
		// 51-cell status CUTS at W−1 with a … (the old code soft-wrapped
		// it; the crash-on-violation makes the cut structural).
		expect(narrow).toContain("▸ default · /mode to switch · faux · ctx left ~10…\x1b[0m");
		expect(narrow).toContain("\x1b[1G\x1b[0K\x1b[2m▸ default"); // the status write — the first bottom-up row (H, relative — invariant ②) — never truncated from the left
	}, 90_000);
});
