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

import { execFileSync } from "node:child_process";
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
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 240_000, env: process.env });
}

/** The SETTLED screen — the VT grid built from the bytes before the dock
 *  teardown (CSI r). */
export function settledScreen(raw: string, rows = 24, cols = 100): string[] {
	return settledTerm(raw, rows, cols).visible();
}

/** The whole emulator at the settle, for the gates that need the CURSOR
 *  as well as the rows (TUI2-R1.5 ⑩). */
export function settledTerm(raw: string, rows = 24, cols = 100): VtScreen {
	const at = raw.indexOf("\x1b[r");
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
	const screen = new VtScreen(rows, cols);
	screen.write(Buffer.from(raw.slice(0, at < 0 ? raw.length : at + marker.length), "utf8"));
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
