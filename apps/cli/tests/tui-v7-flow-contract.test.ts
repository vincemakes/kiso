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
/**
 * DECLARED SUPERSESSION (R3h, 2026-08-29) — `thought 0s` IS DROPPED, so
 * the fold's lead term is OPTIONAL in these patterns. R3b ruled that a
 * zero term is a sentence about something that did not happen; the
 * thought term was exempt by accident (written before the rule). The
 * faux model emits no thinking, so every fold here led with `thought
 * 0s` — which is exactly the sentence the rule forbids.
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
        if post and "took ".encode() in full and fired < len(post):
            rows, cols_n = post[fired]
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols_n, 0, 0))
            os.kill(pid, signal.SIGWINCH)
            resizes.append([len(full), rows, cols_n])
            fired += 1
        # the run is over when the recap has rendered. R3d: the recap
        # names the WORK ("1 read · 1 shell"), so "2 tools" is gone — the
        # stable marker is a term only the recap writes: the running
        # status row carries "ctx left" too, so that would fire early; the W9 resize (if any) has
        # fired by then — drain the buffered repaint so the transcript
        # captures it, then stop
        if "took ".encode() in full and fired >= len(post) and not broke:
            time.sleep(0.6)
            # drain until quiet — a wide terminal's settle frame is several
            # pipe-buffer chunks (the 120-col frame ≈ 2 KB); one read can
            # stop mid-frame and the transcript loses the frame's wrap-close
            while True:
                r, _, _ = select.select([fd], [], [], 0.5)
                if not r:
                    break
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                full += data
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
 *  (the recap's "1 shell" marks the end — the running status never
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
		["▌ ", "go\r"], // the submit
		["needs approval", "y\r"], // the rule line's dim run — the default tier ASKS the shell, answer the panel
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

/** The settled shell block's body rows (below the   shell header). The
 *  header FOLDS at narrow widths (the command + the CJK run past W) — the
 *  fold rows are skipped, then the contiguous body-prefixed rows (the
 *  tail rows + the renderer cut) are collected. */
function shellBody(grid: string[]): string[] {
	const h = grid.findIndex((l) => l.includes("  shell"));
	expect(h).toBeGreaterThanOrEqual(0);
	// R1.5 ④: a settled shell has NO body rows at all, so "none" is a legal
	// answer here now — the helper reports what it finds.
	const start = grid.findIndex((l, i) => i > h && (l.startsWith("│ ") || l.startsWith("└ ")));
	if (start < 0) return [];
	const body: string[] = [];
	for (let i = start; i < grid.length; i += 1) {
		if (grid[i]!.startsWith("│ ") || grid[i]!.startsWith("└ ")) body.push(grid[i]!);
		else break;
	}
	return body;
}

describe("TUI v7 — the flow contract (real PTY, the VT emulator)", () => {
	// MOVED (R1.5 slice 4, the settled-shell-body class — DECLARED THIS
	// ROUND): W7's five-row cap on the settled shell tail is retired with
	// the tail itself (VD-5). What the case pins now is the limit: the
	// settled shell owns ZERO body rows at either width, and the CJK line
	// it was guarding is behind ctrl+r rather than on the screen. The
	// read_file cut note, the ALIVE check and the wide-char fold at the
	// narrow winch are untouched — they were never about the shell.
	it("R1.5 4 at 60 cols: the settled shell owns NO body rows; the tool's own cut note still reaches the human", () => {
		const { hex, alive } = runFlow(60);
		expect(alive).toBe("ALIVE"); // the R2 crash class (a ≤100 thinking at a narrow winch) survives
		const grid = finalGrid(hex, 60);
		// R3b (owner ruling): the settled shell is inside the segment fold —
		// the run's rows moved behind `ctrl+r`. "The settled shell owns ZERO
		// body rows" is this case's claim and it is now true by
		// construction; what the grid must show is the FOLD, and what it
		// must still not show is the tail.
		expect(grid.findIndex((l) => l.startsWith("✦ "))).toBeGreaterThanOrEqual(0); // R3g: the fold OR the recap — the claim is that the turn settled
		// the shell's OUTPUT is behind the key: no tail rows, no cut row
		expect(grid.join("")).not.toContain("earlier rows");
		expect(grid.join("\n")).not.toMatch(/^\u2502 (seq|1[012])/m);
		// the tool's OWN cut is named (W10) — the read's offset note reaches
		// the human, never only the model
		// MOVED (TUI2-R2pre ④, the display-verb class — DECLARED THIS ROUND):
		// the advisory is addressed to the HUMAN, so it names the act; the
		// actionable half (offset=201) is untouched.
		// R3b: the read's advisory is inside the segment fold, like every
		// other row of the run — never dropped. The claim "the human is
		// told, not only the model" holds through the fold; what would
		// break it is silence, and the fold is not silent.
		// DECLARED SUPERSESSION (R4a, owner ruling 2026-08-30): the fold row
		// prints no key. The claim here — the advisory is not dropped, it
		// is folded and reachable — is unchanged; what carried it was the
		// printed key, and what carries it now is the fold's own WORDS
		// plus the behaviour the unit suite pins (ctrl+r appends the run's
		// rows). A row cannot promise which fold a key opens, so it stopped
		// promising; the reference implementation's row is clean too.
		expect(grid.join("\n")).toMatch(/✦ (thought \d+s · )?read /);
	}, 60_000);

	it("R1.5 4 at 120 cols: the same, at the wide width — no body rows, no cut row", () => {
		const { hex, alive } = runFlow(120);
		expect(alive).toBe("ALIVE");
		const grid = finalGrid(hex, 120);
		// R3b (owner ruling): the settled shell is inside the segment fold —
		// the run's rows moved behind `ctrl+r`. "The settled shell owns ZERO
		// body rows" is this case's claim and it is now true by
		// construction; what the grid must show is the FOLD, and what it
		// must still not show is the tail.
		expect(grid.findIndex((l) => l.startsWith("✦ "))).toBeGreaterThanOrEqual(0); // R3g: the fold OR the recap — the claim is that the turn settled
		expect(grid.join("")).not.toContain("earlier rows");
		expect(grid.join("\n")).not.toMatch(/^│ (seq|1[012])/m);
		// MOVED (TUI2-R2pre ④, the display-verb class — DECLARED THIS ROUND).
		// R3b: the advisory rode the read's own row, which is inside the
		// segment fold now. R4a: the fold row prints no key (see the 60-col
		// case above) — its words are the evidence it stands for the run.
		expect(grid.join("\n")).toMatch(/✦ (thought \d+s · )?read /);
	}, 60_000);

	it("W8: two parallel tools, one streaming — the window is a FIXED 3 rows and every row BELOW the streaming cell is byte-identical across the run's frames until settle", () => {
		const { hex, alive } = runFlow(80);
		expect(alive).toBe("ALIVE");
		const frames = frameGrids(hex, 80);
		// DECLARED SUPERSESSION (R3i phase 2) — the SELECTOR moved, the
		// property did not. This picked the frames where a SETTLED read
		// row and a running shell were both on screen; a completed call
		// of an open stretch no longer holds a row, so that pair never
		// occurs. The same moment is now the stretch LINE (which counts
		// the finished read) above a running shell — and the anti-jitter
		// property this case is named for is unchanged and still the
		// subject: everything below the streaming cell is byte-identical
		// across frames, with the running header the one allowed, and
		// in-place, variance.
		const running = frames.filter((f) => f.grid.some((l) => /^[✧✦✶✸✺] .*\bfile\b/.test(l)) && f.grid.some((l) => /^● shell /.test(l)));
		expect(running.length).toBeGreaterThanOrEqual(2); // NON-vacuous: the moment really spans frames
		// the window EXISTS and is 3 rows: 2 blank-padded rows + the waiting row
		const first = running[0]!.grid;
		expect(first.some((l) => l.includes("└ waiting for output"))).toBe(true);
		// W6: the box's input row also opens with "│ " — the blank rows are
		// the ones WITHOUT the › prompt (the window's blanks carry no glyph)
		expect(first.filter((l) => l.startsWith("│ ") && !l.includes("›")).length).toBe(2);
		// the anti-jitter: pairwise across the consecutive running frames,
		// every CONTENT row below the streaming cell's block is byte-identical
		// — the running shell's OWN block (its folded header: the spinner-
		// gutter row down to the first body row, where the spinner glyph +
		// the elapsed live) is the ONE allowed variance, and even that variance
		// is in-place (a growing block would shift the rows below it)
		for (let i = 0; i < running.length - 1; i += 1) {
			const g1 = running[i]!.grid;
			const g2 = running[i + 1]!.grid;
			const readIdx = g1.findIndex((l) => /^[✧✦✶✸✺] /.test(l));
			const readBottom = readIdx; // the stretch line is ONE row, always
			const shellHeader = g1.findIndex((l) => /^● shell /.test(l));
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
				const h = f.grid.findIndex((l) => /^● shell /.test(l));
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
