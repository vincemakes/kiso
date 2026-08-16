/**
 * TUI v6 (V6-1, the lab REVISE — the release blocker): the resize's
 * first frame must make the screen state == the frame state. Two gates:
 *
 * ① the 5-consecutive-resize screen: an idle session (one completed
 *   turn) hit with five consecutive resizes (wide/narrow/tall/short
 *   alternating) — every body line appears EXACTLY once on the final
 *   screen, the separators exactly the chrome's two box rails (the wall —
 *   the duplicated separators the reflow left behind — must never
 *   return), the status once.
 * ② the resize idempotence: the screen after five consecutive resizes
 *   ending at 100×30 is CELL-FOR-CELL equal to the screen after a
 *   single direct resize to 100×30.
 *
 * Both replay the PTY byte stream into the VT emulator (the 5th probe
 * class). The storm gate keeps the byte-level zero-LF invariant; these
 * pin the SCREEN — the two invariants asserted separately.
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

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios, json

def driver(cli, env, feeds, timeout, sizes):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execvp("node", ["node", cli, "chat", "idem"])
    def winsize(rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    winsize(24, 80)
    full = b""
    fed = set()
    seq_at = None
    fired = 0
    end = time.time() + timeout
    resizes = []
    exit_sent = False
    crashed = False
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                # EOF before the exit feed = the child died on its own —
                # the invariant-① crash class (a ≤100 thinking block at a
                # narrow winch).
                if not exit_sent:
                    crashed = True
                break
            full += data
            for i, (needle, text) in enumerate(feeds):
                if i not in fed and needle.encode() in full:
                    os.write(fd, text.encode())
                    fed.add(i)
        if seq_at is None and "0 tools".encode() in full:
            seq_at = time.time()
        if seq_at is not None and fired < len(sizes) and time.time() - seq_at >= 0.3 * (fired + 1):
            winsize(*sizes[fired])
            os.kill(pid, signal.SIGWINCH)
            resizes.append([len(full), sizes[fired][0], sizes[fired][1]])
            fired += 1
        if seq_at is not None and fired >= len(sizes) and time.time() - seq_at >= 0.3 * (len(sizes) + 1):
            os.write(fd, b"exit\\r")
            exit_sent = True
            break
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    print("CRASHED" if crashed else "ALIVE")
    print(json.dumps(resizes))
    sys.stdout.write(full.hex())
    sys.exit(0)
`;

/** Run the turn, fire the resize sequence, replay into the emulator. */
function runAndScreen(sizes: [number, number][], timeout = 30): { grid: string[]; resizes: [number, number, number][] } {
	const { env } = isolatedEnv();
	const dir = mkdtempSync(join(tmpdir(), "kiso-v6-idem-"));
	const script = join(dir, "faux.json");
	writeFileSync(
		script,
		JSON.stringify([
			{
				events: [
					// the ≤100 thinking — the SHORT-CIRCUIT branch was W-blind:
					// at the 20-col winch the raw line tripped invariant ① (the
					// crash still live on npm) — the fold must width-cut it.
					{ type: "thinking", text: "T".repeat(40) },
					// the CJK wide-char line — 20 × 2 cells — the display-width
					// fold at the narrow winches (a char-based cut would split it).
					{ type: "text_delta", text: "I'm the faux model. Let me look at the working directory." + "\u4f60".repeat(20) },
					{ type: "stop", reason: "end_turn" },
				],
			},
		]),
		"utf8",
	);
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify({ ...env, KISO_FAUX_SCRIPT: script })}, ${JSON.stringify([["▌ ", "go\r"]])}, ${timeout}, ${JSON.stringify(sizes)})
`;
	const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
	const lines = out.split("\n");
	// the process SURVIVED the whole resize sequence — the driver's
	// first line (the EOF before the exit feed = the invariant-① crash)
	expect(lines[0]).toBe("ALIVE");
	const resizes = JSON.parse(lines[1]!);
	const hex = out.slice(out.indexOf("\n", out.indexOf("\n") + 1) + 1);
	const emu = new VtScreen(24, 80);
	let pos = 0;
	for (const [off, rows, cols] of resizes as [number, number, number][]) {
		emu.write(Buffer.from(hex, "hex").subarray(pos, off));
		pos = off;
		emu.resize(rows, cols);
	}
	emu.write(Buffer.from(hex, "hex").subarray(pos));
	return { grid: emu.visible(), resizes };
}

const FIVE = [
	[30, 60],
	[20, 140],
	[30, 20],
	[20, 40],
	[24, 30],
] as [number, number][];

describe("TUI v6 (V6-1) — the resize screen-state == frame-state", () => {
	it("① five consecutive resizes: every body line EXACTLY once, the separators exactly the chrome's two box rails, the status once", () => {
		const { grid, resizes } = runAndScreen(FIVE);
		expect(resizes).toHaveLength(5);
		// the body lines, each exactly once
		expect(grid.filter((l) => l.includes("I'm the faux model")).length).toBe(1);
		expect(grid.filter((l) => l === " go ").length).toBe(1); // the 2026-08-09 ruling: the chip alone, flush left (one space each side — the rail + the indent retired)
		expect(grid.filter((l) => l.includes("0 tools")).length).toBe(1);
		expect(grid.filter((l) => l.includes("session ")).length).toBe(1);
		// the chrome: two box rails (the top ╭─╮ + the bottom ╰─╯ — the
		// design §03, W6), the status once, the input row once — the WALL
		// is 3+ separators
		expect(grid.filter((l) => l.includes("╭") || l.includes("╰")).length).toBe(2);
		expect(grid.filter((l) => l.includes("▸ default")).length).toBe(1);
		expect(grid.filter((l) => l.includes("› ")).length).toBe(1);
	});

	it("② the resize idempotence: five consecutive resizes to 100×30 == a single direct 100×30, cell for cell", () => {
		const consecutive = runAndScreen([
			[20, 60],
			[40, 140],
			[24, 20],
			[60, 40],
			[100, 30],
		]);
		const direct = runAndScreen([[100, 30]]);
		expect(consecutive.grid).toEqual(direct.grid);
	});
});
