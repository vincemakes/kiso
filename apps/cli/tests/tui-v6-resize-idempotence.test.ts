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
        if seq_at is None and "took ".encode() in full:
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
		// R2 (law 1.6's recorded reversal): the chip spans the WIDTH, so the
		// row is the words plus the band's padding — trimmed, it is what it
		// always was, and "exactly once" is still the claim.
		expect(grid.filter((l) => l.trimEnd() === "  go").length).toBe(1); // the 2026-08-09 ruling: the chip alone, flush left. R13 D4: TWO columns of inner pad now, so the chip's text begins in the same column as the model's (E3) and as a card's rows (E4).
		expect(grid.filter((l) => l.includes("✦ took ")).length).toBe(1);
		// R2: the opening grew from five rows to seven (three labelled facts
		// and a keys row replaced two art rows and a tagline), so on a
		// 24-row screen the session header can scroll off the FINAL grid.
		// The subject here is DUPLICATION — a resize repainting a line it
		// already painted — and that is what is asserted: never twice.
		expect(grid.filter((l) => l.includes("session ")).length).toBeLessThanOrEqual(1);
		// the chrome: two rails, the status once, the input row once — the
		// WALL is 3+ separators. R2 (law 1.1): the two rails are the SAME
		// dashed rule now; the COUNT is the claim and it is unchanged.
		expect(grid.filter((l) => /^\u2500+$/.test(l.trimEnd())).length).toBe(2);
		expect(grid.filter((l) => l.includes("▸ default")).length).toBe(1);
		// the INPUT row, once. R2: it used to be found by its `\u203a ` lead,
		// which is gone — and the hint cannot stand in for it, because the
		// final size here is 30 columns and the #16g rule drops the hint
		// before it truncates the status. The row is the one between the
		// two rails, which is the CHROME_ROWS=4 contract and cannot be
		// satisfied by a stray glyph anywhere else on the screen.
		const rails = grid.map((l, i) => (/^\u2500+$/.test(l.trimEnd()) ? i : -1)).filter((i) => i >= 0);
		expect(rails).toHaveLength(2);
		expect(rails[1]! - rails[0]!).toBe(2); // exactly ONE row between them
	});

	// DECLARED SUPERSESSION (DC-34, adjudicated 2026-09-01) — ② ASSERTED
	// PATH INDEPENDENCE, AND THE INK CONTRACT FORBIDS IT.
	//
	// The old storm passed through a geometry short enough to push
	// committed rows off the top. On a terminal that does not reflow its
	// scrollback, those rows are IRREVERSIBLY there — at the width they
	// left at — and the direct path, which never shrank, never put them
	// there. The two histories genuinely differ, and equalising them
	// would mean reaching into the terminal's scrollback: exactly what
	// ADR-0046 refuses, and what the other implementation does instead.
	//
	// The condition is NOT "no width narrower than the destination". Two
	// measured counter-examples killed that reading: a storm dipping to
	// 20 columns with tall heights stays identical (the frontier never
	// moves), and a storm whose widths never drop below 40 diverges (a
	// 20-ROW intermediate overflows). What decides it is whether an
	// intermediate geometry SCROLLS committed content off the top.
	//
	// So the case keeps its subject — a storm ends where a direct resize
	// ends — over the family where that is achievable: intermediates
	// with room for the content they hold.
	it("② the resize idempotence: a NON-OVERFLOWING storm to 100×30 == a single direct 100×30, cell for cell", () => {
		const consecutive = runAndScreen([
			[100, 60],
			[100, 140],
			[100, 20],
			[100, 40],
			[100, 30],
		]);
		const direct = runAndScreen([[100, 30]]);
		expect(consecutive.grid).toEqual(direct.grid);
	});

	/**
	 * DECLARED SUPERSESSION (R14 / route B, 2026-09-05) — THE SEAM IS
	 * GONE, AND THIS CASE CAME BACK FOR IT.
	 *
	 * The case that stood here asserted the OPPOSITE of what stands here
	 * now: that a storm which scrolls content away does NOT end where the
	 * direct resize ends. It carried its own instruction for this moment —
	 * "the storm equalled the direct resize, which is a REASON TO COME
	 * BACK, not a pass" — and route B is that reason.
	 *
	 * The seam was never a defect in the renderer. It followed from
	 * ADR-0046 §3: the scrollback belongs to the terminal, kiso may not
	 * rewrite it, so rows that left at 20 columns stay folded at 20
	 * columns forever and the path taken to a geometry is visible in the
	 * result. Amendment 1 retires that premise. `2J H 3J` erases the
	 * scrollback and the session is reprinted from the model at the
	 * current width, so the terminal holds one rendering of a transcript
	 * that does not remember how it got here. Path independence stops
	 * being an exception granted to non-overflowing storms and becomes
	 * the contract.
	 *
	 * This is the plan's G7, measured on a real CLI rather than on the
	 * unit-level emulator (`r14-reprint-completeness` carries that half).
	 */
	it("G7 — an OVERFLOWING storm now ends where the direct resize ends too", () => {
		const overflowing = runAndScreen([
			[20, 60],
			[40, 140],
			[24, 20],
			[60, 40],
			[100, 30],
		]);
		const direct = runAndScreen([[100, 30]]);
		// NON-VACUITY: two empty grids are equal. The direct render has to
		// be holding the session before the comparison says anything —
		// this round has already caught three gates that were green
		// against the defect they named.
		expect(direct.grid.flat().join("").trim().length, "the direct resize rendered nothing to compare").toBeGreaterThan(20);
		expect(overflowing.grid).toEqual(direct.grid);
	});
});
