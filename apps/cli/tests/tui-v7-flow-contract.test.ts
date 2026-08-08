/**
 * TUI v7 — the flow contract (W7, W8, W9, W10; the work order §4),
 * through the CLI's topmost entry on a REAL PTY, replayed into the VT
 * emulator. ONE scenario feeds the four event shapes the contract
 * claims to cover (the round-2 gate discipline — a text_delta-only
 * faux script proves nothing):
 *
 *   - a thinking block (the ≤100 short-circuit — the R2 crash class at
 *     the narrow winch, re-verified by the ALIVE marker at 60 cols);
 *   - TWO parallel tools (read_file + shell in one turn — the
 *     streaming execution launches both);
 *   - one streaming (the read's result arrives while the shell still
 *     runs — its block "streams in" mid-run, the anti-jitter moment);
 *   - streamed shell output (a 13-line result — the settled tail) with
 *     a CJK wide-char line (\u4f60×35 = 70 cells — folds at 60, never
 *     splits, counted post-fold).
 *
 * The gates: W7's caps are POST-FOLD screen rows at the CURRENT width
 * (asserted at 60 cols AND 120 cols — the cut counts differ by the
 * fold); W8's done-criterion is the anti-jitter assertion (with two
 * parallel tools, one streaming, every row BELOW the streaming cell is
 * byte-identical across the run's frames — the spinner row the one
 * in-place variance); W10 names BOTH cuts (the renderer's └ +N …
 * ctrl+r and the tool's └ capped by read_file · offset=201); W9's
 * frame cadence stays at the 0.1.35 bound (no per-frame re-measure
 * storm) and a post-run resize repaints exactly once.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { VtScreen } from "./helpers/vt-screen.js";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios, json

def driver(cli, env, feeds, timeout, cols, post):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execvp("node", ["node", cli, "chat"])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, cols, 0, 0))
    full = b""
    fed = set()
    end = time.time() + timeout
    fired = 0
    broke = False
    crashed = False
    exit_sent = False
    resizes = []
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                # EOF before the timeout = the child died on its own (the
                # invariant-① crash class — the ≤100 thinking at a narrow
                # winch; the ALIVE marker re-verifies the R2 fix at 60 cols)
                if not exit_sent:
                    crashed = True
                break
            full += data
            for i, (needle, text) in enumerate(feeds):
                if i not in fed and needle.encode() in full:
                    os.write(fd, text.encode())
                    fed.add(i)
        if post and "2 tools".encode() in full and fired < len(post):
            rows, cols_n = post[fired]
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols_n, 0, 0))
            os.kill(pid, signal.SIGWINCH)
            resizes.append([len(full), rows, cols_n])
            fired += 1
        # the run is over when the recap ("2 tools" — the running status
        # never mentions tools) has rendered; the W9 resize (if any) has
        # fired by then — drain the buffered repaint so the transcript
        # captures it, then stop
        if "2 tools".encode() in full and fired >= len(post) and not broke:
            time.sleep(0.6)
            r, _, _ = select.select([fd], [], [], 0.5)
            if r:
                try:
                    full += os.read(fd, 65536)
                except OSError:
                    pass
            broke = True
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

/** Run the flow scenario at `cols`; `postResizes` fire after the turn
 *  (the recap "2 tools" marks the end — the running status never
 *  mentions tools — and the W9 re-measure fires from it). */
function runFlow(cols: number, postResizes: [number, number][] = []): { hex: string; alive: string; resizes: [number, number, number][] } {
	const { env } = isolatedEnv();
	// the read target lives INSIDE the workspace: the tools refuse absolute
	// paths and everything outside it (the workspace boundary, Area 5) —
	// a temp dir under the repo root, removed before the test returns
	const dir = mkdtempSync(join(process.cwd(), ".kiso-v7-flow-"));
	// the CJK read target: 250 lines — read_file caps at DEFAULT_READ_LINES
	// 200 and appends the offset continuation note (the W10 tool-cut fact)
	const cjkFile = join(dir, "cjk.txt");
	writeFileSync(cjkFile, Array.from({ length: 250 }, (_, i) => `read line ${i} ` + "\u4f60".repeat(2)).join("\n"), "utf8");
	const script = join(dir, "faux.json");
	writeFileSync(
		script,
		JSON.stringify([
			{
				events: [
					// the thinking block — the ≤100 short-circuit branch
					{ type: "thinking", text: "Let me check the working directory state before deciding." },
					// TWO parallel tools, one streaming: the read settles
					// while the shell still runs (the anti-jitter moment).
					// The path is WORKSPACE-RELATIVE: the tools refuse
					// absolute inputs (the workspace boundary, Area 5)
					{ type: "tool_call_end", callId: "a", name: "read_file", input: { path: join(dir.split("/").pop()!, "cjk.txt") } },
					{ type: "tool_call_end", callId: "b", name: "shell", input: { command: "sleep 2; seq 1 12; echo " + "\u4f60".repeat(35) } },
					{ type: "stop", reason: "tool_use" },
				],
			},
			{
				events: [
					{ type: "text_delta", text: "The directory shows the file and its contents." },
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
driver(${JSON.stringify(CLI)}, ${JSON.stringify({ ...env, KISO_FAUX_SCRIPT: script })}, ${JSON.stringify([
		["▌ ", "go\n"], // the submit
		["approve shell", "y\n"], // the default tier ASKS the shell — answer it
	])}, 30, ${cols}, ${JSON.stringify(postResizes)})
`;
	let out: string;
	try {
		out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	const lines = out.split("\n");
	const hex = out.slice(out.indexOf("\n", out.indexOf("\n") + 1) + 1);
	return { hex, alive: lines[0]!, resizes: JSON.parse(lines[1]!) };
}

/** The transcript split into DEC-2026 frames, replayed incrementally
 *  into ONE emulator (the steady frames are relative-move deltas — a
 *  fresh emulator per frame would misplace them). Returns each frame's
 *  bytes, its transcript start offset, and the grid it leaves behind. */
function frameGrids(hex: string, cols: number): { offset: number; grid: string[] }[] {
	const s = Buffer.from(hex, "hex").toString("latin1");
	const emu = new VtScreen(24, cols);
	// the pre-dock bytes (the banner) feed before the first frame
	const first = s.indexOf("\x1b[?2026h");
	emu.write(Buffer.from(s.slice(0, first), "latin1"));
	const frames: { offset: number; grid: string[] }[] = [];
	let at = first;
	while (at >= 0) {
		const end = s.indexOf("\x1b[?2026l", at);
		if (end < 0) break;
		emu.write(Buffer.from(s.slice(at, end + "\x1b[?2026l".length), "latin1"));
		frames.push({ offset: at, grid: emu.visible() });
		at = s.indexOf("\x1b[?2026h", end);
	}
	return frames;
}

/** The final screen's grid. */
function finalGrid(hex: string, cols: number): string[] {
	const frames = frameGrids(hex, cols);
	return frames[frames.length - 1]!.grid;
}

/** The settled shell block's body rows (below the ✓ shell header). The
 *  header FOLDS at narrow widths (the command + the CJK run past W) — the
 *  fold rows are skipped, then the contiguous body-prefixed rows (the
 *  tail rows + the renderer cut) are collected. */
function shellBody(grid: string[]): string[] {
	const h = grid.findIndex((l) => l.includes("✓ shell"));
	expect(h).toBeGreaterThanOrEqual(0);
	const start = grid.findIndex((l, i) => i > h && (l.startsWith("│ ") || l.startsWith("└ ")));
	expect(start).toBeGreaterThanOrEqual(0);
	const body: string[] = [];
	for (let i = start; i < grid.length; i += 1) {
		if (grid[i]!.startsWith("│ ") || grid[i]!.startsWith("└ ")) body.push(grid[i]!);
		else break;
	}
	return body;
}

describe("TUI v7 — the flow contract (real PTY, the VT emulator)", () => {
	it("W7 at 60 cols: the settled shell tail caps at 5 POST-FOLD screen rows (+10 — the CJK line folds), the tool cut is named, the CJK wide-char line survives the fold", () => {
		const { hex, alive } = runFlow(60);
		expect(alive).toBe("ALIVE"); // the R2 crash class (a ≤100 thinking at a narrow winch) survives
		const grid = finalGrid(hex, 60);
		const body = shellBody(grid);
		// the cap: 4 tail rows + the renderer cut = 5, the cut row INSIDE the cap
		expect(body.length).toBeLessThanOrEqual(5);
		expect(body.at(-1) ?? "").toContain("└ +10 earlier rows · ctrl+r");
		// the tail is the tail: the LAST output line is on screen
		expect(grid.join("")).toContain("12");
		// the CJK wide-char line (\u4f60×35 = 70 cells) folded — never split —
		// and its continuation row is visible
		expect(grid.join("")).toContain("\u4f60");
		// the tool's OWN cut is named (W10) — the read's offset note reaches
		// the human, never only the model
		expect(grid.join("")).toContain("└ capped by read_file · offset=201 for the rest");
		// the read block renders NO output body — the settled row carries the count
		const readIdx = grid.findIndex((l) => l.includes("✓ read_file"));
		expect(grid[readIdx + 1]).toContain("└ capped by read_file");
	}, 60_000);

	it("W7 at 120 cols: the same scenario — the caps hold at the wide width too, the cut count reflects the wider fold (+9 — no CJK fold)", () => {
		const { hex, alive } = runFlow(120);
		expect(alive).toBe("ALIVE");
		const grid = finalGrid(hex, 120);
		const body = shellBody(grid);
		expect(body.length).toBeLessThanOrEqual(5);
		expect(body.at(-1) ?? "").toContain("└ +9 earlier rows · ctrl+r");
		expect(grid.join("")).toContain("\u4f60");
		expect(grid.join("")).toContain("└ capped by read_file · offset=201 for the rest");
	}, 60_000);

	it("W8: two parallel tools, one streaming — the window is a FIXED 3 rows and every row BELOW the streaming cell is byte-identical across the run's frames until settle", () => {
		const { hex, alive } = runFlow(80);
		expect(alive).toBe("ALIVE");
		const frames = frameGrids(hex, 80);
		// the frames while the shell runs: the read (the streaming cell) has
		// settled, the shell is still running — the grid carries BOTH markers
		const running = frames.filter((f) => f.grid.some((l) => l.includes("✓ read_file")) && f.grid.some((l) => /^[▖▘▝▗] shell /.test(l)));
		expect(running.length).toBeGreaterThanOrEqual(2); // NON-vacuous: the moment really spans frames
		// the window EXISTS and is 3 rows: 2 blank-padded rows + the waiting row
		const first = running[0]!.grid;
		expect(first.some((l) => l.includes("└ waiting for output"))).toBe(true);
		expect(first.filter((l) => l.startsWith("│ ")).length).toBe(2);
		// the anti-jitter: pairwise across the consecutive running frames,
		// every CONTENT row below the streaming cell's block is byte-identical
		// — the running shell's OWN block (its folded header: the spinner-
		// gutter row down to the first body row, where the spinner glyph +
		// the elapsed live) is the ONE allowed variance, and even that variance
		// is in-place (a growing block would shift the rows below it)
		for (let i = 0; i < running.length - 1; i += 1) {
			const g1 = running[i]!.grid;
			const g2 = running[i + 1]!.grid;
			const readIdx = g1.findIndex((l) => l.includes("✓ read_file"));
			const readBottom = readIdx + (g1[readIdx + 1]?.startsWith("└ ") ? 1 : 0);
			const shellHeader = g1.findIndex((l) => /^[▖▘▝▗] shell /.test(l));
			expect(shellHeader).toBeGreaterThan(readBottom); // the shell sits BELOW the streaming cell
			const headerEnd = g1.findIndex((l, i) => i > shellHeader && (l.startsWith("│ ") || l.startsWith("└ ")));
			for (let r = readBottom + 1; r <= 19; r += 1) {
				if (r >= shellHeader && r < headerEnd) continue; // the running cell's own header span
				expect(g2[r]).toBe(g1[r]); // byte-identical
			}
		}
		// the in-place variance really exists: the running header (the
		// spinner glyph + the elapsed) differs across the run — ≥ 2 distinct
		const headers = new Set(
			running.map((f) => {
				const h = f.grid.findIndex((l) => /^[▖▘▝▗] shell /.test(l));
				const he = f.grid.findIndex((l, i) => i > h && (l.startsWith("│ ") || l.startsWith("└ ")));
				return f.grid.slice(h, he).join("");
			}),
		);
		expect(headers.size).toBeGreaterThanOrEqual(2);
	}, 60_000);

	it("W9: the frame cadence stays at the 0.1.35 bound while the shell runs — no per-frame re-measure storm; a post-run resize repaints exactly once", () => {
		const { hex, alive, resizes } = runFlow(80, [[24, 50]]);
		expect(alive).toBe("ALIVE");
		expect(resizes).toHaveLength(1);
		const frames = frameGrids(hex, 80);
		// the whole run: ~1 frame per 200ms spinner tick over the 2s shell —
		// a per-frame re-measure storm would emit one frame per 16ms (~125+)
		expect(frames.length).toBeLessThanOrEqual(40);
		// the resize (the W9 re-measure) repaints exactly once: the frames
		// after the recorded resize offset = the repaint frame + coalescing
		const after = frames.filter((f) => f.offset > resizes[0]![0]);
		expect(after.length).toBeLessThanOrEqual(2);
		// and the repaint re-measured at the NEW width: the final grid is
		// the narrow 50-col geometry (the caps hold there too)
		const grid = frames[frames.length - 1]!.grid;
		const body = shellBody(grid);
		expect(body.length).toBeLessThanOrEqual(5);
	}, 60_000);
});
