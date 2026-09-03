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

/**
 * DECLARED SUPERSESSION (R3g, 2026-08-28) — THE RECAP IS THE TURN'S
 * COST, NOT ITS WORK.
 *
 * The turn's work is said ONCE now, by the compositor's fold line, in
 * the place the work happened and carrying the key that reopens it.
 * This row used to repeat the same terms a few rows below under a
 * different clock — the fold printed the kernel's MEASURED thinking
 * seconds, the recap the whole turn's wall, both labelled "thought" —
 * which is the doubling the owner called out ("two lines saying the
 * same thing, the UI gets strange"). The row reads `✦ took 23s · in
 * 12k out 900 · cache 88% · ctx left 41%`, and `took` is the honest
 * name for the number it always carried.
 *
 * A turn whose work did NOT fold (it spilled past the live region, or
 * it hit trouble) keeps every one of its rows on screen — the work is
 * not lost by its absence from this row, it is standing right there.
 *
 * Needles that waited on a recap TERM ("0 tools", "1 shell") wait on
 * `took ` now: it is what the recap always writes, it marks the same
 * moment (the turn has settled), and it sits after the ✦'s SGR reset
 * so it survives contiguously in the raw stream a PTY driver scans.
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
        # count them). The recap "✦ 0s" only exists once the freeze frame
        # has written — the turn is fully frozen by then.
        if storm_at is None and "took ".encode() in full:
            storm_at = time.time()
        if storm_at is not None and fired < len(sizes) and time.time() - storm_at >= 0.5 * (fired + 1):
            winsize(*sizes[fired])
            os.kill(pid, signal.SIGWINCH)
            fired += 1
        if storm_at is not None and not exit_sent and time.time() - storm_at >= (0.5 * (len(sizes) + 1) if len(sizes) else 1.0):
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
				["/ commands · \u2191 history", "look around\r"], // #16d + W6: the box's light prompt alone (no "you> ")
			],
		);
		// the process SURVIVED the whole storm — the driver's leading marker
		// (the EOF before the exit feed = the invariant-① crash class)
		expect(out.startsWith("ALIVE=1\n")).toBe(true);

		// The storm window: from the recap's freeze frame (the turn is
		// fully frozen — the idle dock redraw lands BEFORE the body's 16ms
		// frame commits the frozen cells, and those real-LF commits must
		// not count inside the window) to the exit.
		const stormAt = out.indexOf("took ");
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
		// MOVED (R1.5 slice ⑨, the wrap class — DECLARED THIS ROUND):
		// re-baseline 2 → 4, the same kind of adjustment R-D 0.1.45 made
		// for the banner. VD-10 made the assistant's body text WORD-aware,
		// which makes its row count width-sensitive the way the banner's
		// already was: a winch can now change the text cell's height, and
		// the V6-1 resize re-paint fires its one bounded empty-row LF for
		// that too. Measured at 4 on three consecutive runs, stable. The
		// property the gate exists for — no LF-pushed redraw, no dashed-line
		// pileup — is carried by the screen assertions below, which are
		// untouched and still pin the visual state.
		expect(storm.split("\n").length - 1).toBeLessThanOrEqual(4);

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
		const sepLines = (t: string): number => t.split("\n").filter((l) => /^\u2500+$/.test(l.trimEnd())).length; // R2: one rule, both rails
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
			// V6-3: the chrome — at most TWO rails on the screen (the exit's
			// chrome-clear may wipe them — the WALL, the duplicated rails the
			// reflow left behind, would exceed 2). R2: the top and bottom are
			// the same rule now, so the bound counts both rather than one.
			expect(grid.filter((l) => /^\u2500+$/.test(l.trimEnd())).length).toBeLessThanOrEqual(2);
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
		// R2 (law 1.6's recorded reversal): the chip spans the WIDTH, so
		// the bar no longer closes right after the words.
		expect(out).toContain("\x1b[7m  look around"); // R13 D4: the chip's inner pad is TWO columns now, so its text begins in the same column as the model's (E3) and as a card's rows (E4).
		expect(out).not.toContain("\x1b[48;5;237m"); // the fixed dark background stays banned

		// ④ #16d/#16e: the input row carries NO prompt glyph at all (R2 —
		// the cursor sits at column one). The bans this case exists for —
		// no blue, no "you> " — are unchanged and are what it asserts.
		expect(out).not.toContain("\u203a ");
		expect(out).not.toContain("\x1b[38;5;75m");
		expect(out).not.toContain("you> ");
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
		const wide = stormRun({ ...env, KISO_FAUX_SCRIPT: script }, [["/ commands · \u2191 history", "look around\r"]], 30);
		// R2: this used to assert `\u203a ` — the composer's chevron, which
		// is gone (the cursor sits at column one now). It was a proxy for
		// "the chrome drew", and a poor one: the byte it matched was
		// actually the resume tail's, not the composer's. The case is about
		// the HINT riding the status row, so that is what it asserts.
		expect(wide).toContain("/ commands · \u2191 history");
		// 50 cols: status + hint = 73 > 50 → the HINT is cut — the status
		// itself is never truncated for it. The idle row's dim span ends
		// IMMEDIATELY after the status (the hint, had it fit, would sit
		// between the status and the reset).
		const narrow = stormRun({ ...env, KISO_FAUX_SCRIPT: script }, [["/ commands · \u2191 history", "look around\r"]], 30, 50, []);
		// v6 invariant ①: the status itself must fit W — at 50 cols the
		// 51-cell status CUTS at W−1 with a … (the old code soft-wrapped
		// it; the crash-on-violation makes the cut structural).
		expect(narrow).toContain("▸ default · /mode to switch · faux · ctx left ~10…\x1b[0m");
		// DECLARED SUPERSESSION (REL-0152-R1): the status row is written
		// by ROW NUMBER now, not by a CHA at the end of a bottom-up march.
		// The property is that it is never truncated from the LEFT — the
		// cut happens at the right, which is what the `…` in the emitted
		// row shows — and that is what this asserts.
		expect(narrow).toMatch(/\x1b\[\d+;1H\x1b\[0K\x1b\[2m▸ default/);
	}, 90_000);
});
