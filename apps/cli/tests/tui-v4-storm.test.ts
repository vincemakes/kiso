/**
 * TUI v4 #16 — the resize-storm gate (real PTY, real SIGWINCH):
 *
 * ① #16a resize 零推送: after one turn completes, 5× TIOCSWINSZ (wide/
 *   narrow alternating) fire 0.5s apart. The SIGWINCH path must obey the
 *   #14 invariant — redraws are CUP in-place overwrites ONLY: ZERO real
 *   LF during the storm, the separator count in the ANSI-stripped text
 *   does NOT grow (a LF-pushing redraw would add newline-separated
 *   separator rows — the 虚线堆积 the user saw when dragging), and the
 *   model's response text appears EXACTLY once (no re-render duplicates).
 * ② #16b ESC integrity: the banner and the recap keep their SGR — the
 *   stripped text must not contain "[2m"/"[0m"/"[38;5" literals (the
 *   pre-fix code stripped the ESC at the raw cell, leaving literal SGR
 *   text on screen — the 乱码). The storm runs on a session WITH the
 *   banner, so both are covered.
 * ③ #16c theme: the user block is SGR 7m reverse video (theme-following),
 *   never the fixed 48;5;237 background.
 * ④ #16d input row: the brick ▌ alone — no "you>" text.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** The storm driver: 24×80; feeds on needles; after the turn completes
 *  (the IDLE status "▸ default" — the dock's idle state only exists post-
 *  turn), 5 winches (120/60/120/60/100 cols) at 0.5s intervals; then exit.
 *  The transcript is the full byte stream. */
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
    sizes = [(24,120),(24,60),(24,120),(24,60),(24,100)]
    fired = 0
    storm_at = None
    exit_sent = False
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
        if storm_at is None and "▸ default".encode() in full:
            storm_at = time.time()
        if storm_at is not None and fired < len(sizes) and time.time() - storm_at >= 0.5 * (fired + 1):
            winsize(*sizes[fired])
            os.kill(pid, signal.SIGWINCH)
            fired += 1
        if storm_at is not None and fired >= len(sizes) and not exit_sent and time.time() - storm_at >= 0.5 * (len(sizes) + 1):
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
    sys.stdout.write(full.decode(errors="replace"))
`;

function stormRun(env: NodeJS.ProcessEnv, feeds: [string, string][], timeout = 45): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-v4-storm-"));
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

function stripANSI(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
}

describe("TUI v4 #16 — the resize-storm gate (real PTY, 24×80)", () => {
	it("zero LF + stable separators + response exactly once + no ESC residue + rev user block + ▌ input row", () => {
		const { env } = isolatedEnv();
		const out = stormRun(env, [
			["▌ ", "look around\n"], // #16d: the brick alone is the prompt
		]);

		require("node:fs").writeFileSync("/tmp/storm-test-transcript.txt", out);
		// The storm window: from the storm start (the idle status — the
		// turn is complete) to the exit.
		const stormAt = out.indexOf("▸ default");
		expect(stormAt).toBeGreaterThan(0);
		const storm = out.slice(stormAt);
		const clean = stripANSI(storm);

		// ① #16a: ZERO real LF during the storm — CUP in-place redraws only.
		expect(storm.split("\n").length - 1).toBe(0);

		// ① #16a: the separator LINE count does NOT grow — a LF-pushed
		// redraw would add newline-separated separator rows (the 虚线堆积);
		// CUP in-place re-emissions merge into the existing lines (the dock
		// redraw writes no newlines), so the newline-delimited line count
		// is the faithful proxy for the visual state. Whole transcript,
		// before vs after the storm:
		const sepLines = (t: string): number => t.split("\n").filter((l) => l.includes("╌")).length;
		const cleanAll = stripANSI(out);
		expect(sepLines(cleanAll)).toBe(sepLines(cleanAll.slice(0, stormAt)));

		// ① #16a: the model's response text appears EXACTLY once — no
		// tail re-render duplicates (the pre-fix onResize #dirty bug).
		expect((out.match(/I see the workspace/g) ?? []).length).toBe(1);

		// ② #16b: no ESC residue — the banner's dim and the recap's blue
		// keep their ESCs (the pre-fix raw-cell re-escape stripped them,
		// leaving literal "[2m"/"[38;5;75m" text — the 乱码).
		expect(clean).not.toContain("[2m");
		expect(clean).not.toContain("[0m");
		expect(clean).not.toContain("[38;5");

		// ③ #16c: the user block is reverse video — theme-following.
		expect(out).toContain("\x1b[7mlook around\x1b[0m");
		expect(out).not.toContain("\x1b[48;5;237m");

		// ④ #16d: the input row is the blue brick alone.
		expect(out).toContain("\x1b[38;5;75m▌ ");
		expect(out).not.toContain("▌you> ");
	}, 90_000);
});
