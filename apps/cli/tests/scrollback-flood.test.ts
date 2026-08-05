/**
 * v2e — the #13 (P1) gate: the body MUST scroll into the terminal's
 * native scrollback. A 24-row terminal floods 3× the viewport with
 * frozen content; the machine evidence is the LF count (every frozen
 * line is written at H-2 followed by a REAL line feed — the scroll
 * mechanism's bytes) and the freeze semantics (early content appears
 * EXACTLY once — the old overwrite-in-place defect is gone).
 *
 * v2d-B (ADR-0040): no DECSTBM — plain LF scrolling, so the scrollback
 * correctness does not depend on the terminal's region-scroll behavior.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

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

function ptyRun(env: NodeJS.ProcessEnv, feeds: [string, string][], timeout = 60): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-v2e-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${timeout})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 120_000, env: process.env });
}

describe("TUI v2e (real PTY, 24×80) — the #13 scrollback gate", () => {
	it("floods 3× the viewport with frozen content: every frozen line emits a REAL LF (the scroll mechanism) and early content appears EXACTLY once", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-v2e-"));
		const script = join(dir, "faux.json");
		// 25 distinct turns — each freezes a userLine + a text cell + a
		// terminal (label + status + gap) = 5 frozen lines per turn = 125
		// lines, far past the 21-row viewport (3× viewport = 63).
		writeFileSync(
			script,
			JSON.stringify(
				Array.from({ length: 25 }, (_, i) => ({
					events: [
						{ type: "text_delta", text: `flood ${String(i + 1).padStart(2, "0")}` },
						{ type: "stop", reason: "end_turn" },
					],
				})),
			),
			"utf8",
		);
		const batch = Array.from({ length: 25 }, (_, i) => `go ${i + 1}`).join("\n") + "\n";
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["you> ", batch],
				["flood 25", "exit\n"],
			],
		);
		// 1. THE SCROLL MECHANISM'S MACHINE EVIDENCE: every frozen line is
		// written at H-2 (row 22) followed by a REAL line feed. 25 turns ×
		// (userLine + text + terminal-label + status + gap) = 125 frozen
		// lines — assert the LF floor: at least the number of frozen lines
		// beyond the initial fit... in v2d-B EVERY frozen line emits exactly
		// one LF, so the floor is the full frozen-line count.
		const lf = (out.match(/\n/g) ?? []).length;
		// v3 geometry: each turn freezes THREE lines (the user block, the
		// text cell, the recap — the recap replaced the old done label +
		// status + gap); the body fills from the top WITHOUT scrolling (the
		// first ~20 rows write absolutely — 4 dock rows now). Floor =
		// total frozen lines - fit.
		const frozenFloor = 25 * 3 - 20; // 55
		expect(lf).toBeGreaterThanOrEqual(frozenFloor);
		// 2. THE FREEZE SEMANTICS: the FIRST turn's content appears EXACTLY
		// once — the old overwrite-in-place defect would show it repeated or
		// missing; a working scroll shows it once in the stream (it scrolled
		// away into the terminal's scrollback, never rewritten).
		expect((out.match(/flood 01/g) ?? []).length).toBe(1);
		// 3. The LAST turn completed — the flood ran to the end.
		expect(out).toContain("flood 25");
		// 4. No DECSTBM anywhere (v2d-B).
		expect(out).not.toContain("\x1b[1;21r");
	}, 120_000);
});
