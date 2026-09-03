/**
 * TUI2-R1.5 — the shared PTY driver for this round's product gates.
 *
 * The same needle-fed driver the R1 suites use, lifted out of one test
 * file so every slice's gate drives the CLI identically. Two additions
 * this round:
 *
 *  - `settledScreen` builds the VT grid from the bytes BEFORE the dock's
 *    teardown (CSI r, the compositor's exit contract byte), so the exit
 *    repaint never erases what a test is looking at. Byte-stream
 *    assertions cannot answer "what does the settled screen say" — the
 *    stream necessarily carries every live copy painted on the way
 *    there, which is exactly how R1's suite missed VD-1 and VD-5.
 *  - `pacedFeeds` writes its keystrokes on a WALL-CLOCK delay rather
 *    than on a needle, for the gates that must prove behaviour under
 *    real pacing (① ③ ④).
 *
 * A TEST HELPER — not counted in the gate line budgets.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VtScreen } from "./vt-screen.js";

export const CLI = join(fileURLToPath(new URL("../..", import.meta.url)), "dist", "index.js");

const PTY_DRIVER = `
import pty, os, sys, time, select, struct, fcntl, termios, signal

def driver(cli, args, env, feeds, timeout, cwd, rows, cols, delays):
    pid, fd = pty.fork()
    if pid == 0:
        # PH-1a (finding PH-F5, the isolation half): the host shell's
        # NO_COLOR leaked into every PTY child and flipped the palette the
        # byte-pinned grids assert. A test that WANTS it passes it in env.
        if "NO_COLOR" not in env:
            os.environ.pop("NO_COLOR", None)
        if "TERM_PROGRAM" not in env:
            os.environ.pop("TERM_PROGRAM", None)
        os.environ.update(env)
        if cwd:
            os.chdir(cwd)
        os.execvp("node", ["node", cli] + args)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    full = b""
    fed = set()
    start = time.time()
    end = start + timeout
    done = False
    while time.time() < end and not done:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                # THE CHILD IS GONE — on Linux. A pty master raises EIO
                # once the last slave fd closes; macOS returns b"" for the
                # same event, and that path (below) sets done. Treating
                # only the macOS shape as an exit made every Linux run
                # report "the CLI never exited" on a CLI that had exited
                # cleanly a fraction of a second earlier.
                #
                # R3c keeps its teeth: reap with WNOHANG for up to a
                # second, and only call it an exit if the child really is
                # gone. A process still alive behind a broken pty is a
                # stall, and still spends its wall.
                reaped = False
                for _ in range(100):
                    try:
                        if os.waitpid(pid, os.WNOHANG)[0] != 0:
                            reaped = True
                            break
                    except ChildProcessError:
                        reaped = True
                        break
                    time.sleep(0.01)
                if reaped:
                    done = True
                break
            if not data:
                done = True
                break
            full += data
        for i, (needle, text) in enumerate(feeds):
            if i in fed:
                continue
            if needle.encode() in full:
                os.write(fd, text.encode())
                fed.add(i)
        for i, (after, text) in enumerate(delays):
            key = ("d", i)
            if key in fed:
                continue
            if time.time() - start >= after:
                os.write(fd, text.encode())
                fed.add(key)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    # R3c — the driver REPORTS how it ended, on its own channel.
    #
    # It used to exit 0 either way: the CLI closed (done), or the wall ran
    # out. Those are opposite outcomes and the caller could not tell them
    # apart — so a scenario whose needle never fired burned its whole
    # budget, got SIGTERM'd, and handed back a transcript the assertions
    # were usually still happy with. Green, and sixty seconds slower.
    #
    # stderr, because stdout is the transcript the tests parse byte for
    # byte and must not gain a single character.
    unfed = [i for i in range(len(feeds)) if i not in fed]
    sys.stderr.write("KISO_PTY_END %s %.2f %s" % ("eof" if done else "wall", time.time() - start, ",".join(str(i) for i in unfed)) + chr(10))
    sys.stdout.write(full.decode(errors="replace"))
    sys.exit(0)
`;

export interface PtyOpts {
	/** [needle, keystrokes] — fed the first time the needle appears. */
	feeds?: [string, string][];
	/** [secondsAfterStart, keystrokes] — fed on the wall clock (real pacing). */
	delays?: [number, string][];
	timeout?: number;
	cwd?: string;
	rows?: number;
	cols?: number;
}

export function ptyRun(args: string[], env: NodeJS.ProcessEnv, opts: PtyOpts = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-r15-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const a = (v: unknown): string => JSON.stringify(v);
	const phase = `
import sys
sys.argv = [""]
exec(open(${a(driverPath)}).read())
driver(${a(CLI)}, ${a(args)}, ${a(env)}, ${a(opts.feeds ?? [])}, ${opts.timeout ?? 60}, ${opts.cwd === undefined ? "None" : a(opts.cwd)}, ${opts.rows ?? 24}, ${opts.cols ?? 100}, ${a(opts.delays ?? [])})
`;
	const wall = opts.timeout ?? 60;
	const res = spawnSync("python3", ["-c", phase], { encoding: "utf8", timeout: 240_000, env: process.env });
	if (res.status !== 0) throw new Error(`pty driver failed (${res.status}): ${res.stderr}`);
	assertScenarioEnded(res.stderr, wall, opts.feeds ?? []);
	return res.stdout;
}

/**
 * R3c — a scenario that spends its WHOLE WALL is a FAILURE, by name.
 *
 * The class this closes: a feed needle that never appears does not make
 * a test red. The driver simply waits out its budget, the CLI is
 * SIGTERM'd, and the assertions — which read the accumulated transcript
 * — usually still pass. The test is green and sixty seconds slower, and
 * nothing in the suite says so. One of these (tui-v7-expand's W14, whose
 * needle R3a killed) sat green for a whole release while starving
 * vitest's worker RPC and turning `npm run check` red with every test
 * passing. It was found by reading DURATIONS, because there was nothing
 * to read in the failures.
 *
 * THE STARVATION ITSELF is a separate mechanism and now has a separate
 * cure: `tests/setup-pty-yield.ts` turns the event loop once per test,
 * because the worker's reply to the runner is a macrotask and a file of
 * synchronous spawnSync cases never reaches one. A wasted wall is still
 * this file's business; the worker starving is that one's.
 *
 * So the driver reports how it ended and this turns "wall" into a red
 * that names the needle nobody reached. A scenario whose CLI exits on
 * its own (`eof`) is silent, as it always was.
 *
 * The gate is deliberately about the ENDING, not about a duration
 * threshold: a slow-but-correct scenario is not a defect, and a
 * threshold would need tuning per case. "The CLI never exited" is the
 * defect, at any speed.
 */
function assertScenarioEnded(stderr: string, wall: number, feeds: [string, string][]): void {
	const m = /KISO_PTY_END (eof|wall) ([0-9.]+) ([^\n]*)/.exec(stderr);
	if (m === null) return; // a driver too old to report — never a false red
	if (m[1] === "eof") return;
	const unfed = (m[3] ?? "").split(",").filter((x) => x !== "");
	const missed = unfed.map((i) => JSON.stringify(feeds[Number(i)]?.[0] ?? "?")).join(", ");
	throw new Error(
		`the PTY scenario spent its whole ${wall}s wall (${m[2]}s) — the CLI never exited.` +
			(missed === "" ? " Every feed fired, so the exit itself did not take." : ` These needles never appeared: ${missed}.`) +
			" A scenario that waits out its budget passes its assertions on a SIGTERM'd transcript and hides the stall (R3c).",
	);
}

/** The SETTLED screen — the VT grid built from the bytes before the dock
 *  teardown (CSI r). */
export function settledScreen(raw: string, rows = 24, cols = 100): string[] {
	return settledTerm(raw, rows, cols).visible();
}

/** The whole emulator at the settle, for the gates that need the CURSOR
 *  as well as the rows (TUI2-R1.5 ⑩). */
export function settledTerm(raw: string, rows = 24, cols = 100): VtScreen {
	// REL-0152-D19: the LAST one. `ESC[r` marks the teardown — it used to
	// be the only one in the stream, so the first was the last. The dock
	// now also RELEASES an inherited scroll region on entry, because a
	// product whose claim is that it survives kill -9 will regularly be
	// started in a terminal the previous instance never cleaned up. With
	// two in the stream, `indexOf` cut at the boot one and replayed almost
	// nothing.
	const at = raw.lastIndexOf("\x1b[r");
	const screen = new VtScreen(rows, cols);
	screen.write(Buffer.from(at > 0 ? raw.slice(0, at) : raw, "utf8"));
	return screen;
}

/** The emulator as it stood when `marker` was last painted.
 *
 *  The cut lands on a FRAME BOUNDARY, not on the marker: the compositor
 *  brackets every frame in DEC 2026 synchronized output, and the cursor
 *  is placed by the LAST bytes of a frame. Slicing at the marker itself
 *  would read the cursor mid-paint — wherever the write happened to be —
 *  which is a measurement artefact and not a claim the product makes.
 *  A terminal never shows a half-frame either; this is what it sees. */
export function termAt(raw: string, marker: string, rows = 24, cols = 100): VtScreen {
	const at = raw.lastIndexOf(marker);
	const screen = new VtScreen(rows, cols);
	screen.write(Buffer.from(at < 0 ? raw : raw.slice(0, frameEndAfter(raw, at + marker.length)), "utf8"));
	return screen;
}

/** The end of the frame containing `from` — the index just past the next
 *  synchronized-output close, or the stream's end. */
export function frameEndAfter(raw: string, from: number): number {
	const close = raw.indexOf("\x1b[?2026l", from);
	return close < 0 ? raw.length : close + "\x1b[?2026l".length;
}

/** The screen as it stood when `marker` was last painted — for the gates
 *  that must read a mid-run frame (a running card, a live panel). The
 *  LAST occurrence is the right one: a live surface repaints every frame,
 *  and its first paint is usually half-drawn. */
export function screenAt(raw: string, marker: string, rows = 24, cols = 100): string[] {
	const at = raw.lastIndexOf(marker);
	// REL-0152-R1: cut at the FRAME's end, not at the marker.
	//
	// A frame is atomic — it is bracketed in synchronized output for
	// exactly that reason — so "the screen when the marker was painted"
	// is only defined once that frame has finished. Cutting at the marker
	// itself worked while the renderer repainted every row bottom-up,
	// because the status row went out FIRST and was already on screen by
	// the time any content row mentioned anything. A diff writes rows in
	// row order, so the status row goes out LAST, and a mid-frame cut
	// truncated it away — the screen showed the panel and not the status
	// line that belonged to it.
	const screen = new VtScreen(rows, cols);
	screen.write(Buffer.from(raw.slice(0, at < 0 ? raw.length : frameEndAfter(raw, at + marker.length)), "utf8"));
	return screen.visible();
}

/** A faux trajectory on disk. Callers keep SPARE turns: an exhausted
 *  script exits the CLI. */
export function fauxScript(turns: unknown[]): string {
	const p = join(mkdtempSync(join(tmpdir(), "kiso-faux-")), "faux.json");
	writeFileSync(p, JSON.stringify(turns), "utf8");
	return p;
}

/** Two spare end_turn trajectories — the exhaustion guard. */
export function spares(n = 2): unknown[] {
	return Array.from({ length: n }, (_, i) => ({ events: [{ type: "text_delta", text: `(spare ${i})` }, { type: "stop", reason: "end_turn" }] }));
}
