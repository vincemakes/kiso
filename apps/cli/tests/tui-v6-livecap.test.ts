/**
 * TUI v6 (ADR-0046) — the live-region cap gate (the one sharp edge):
 * a SUPER-TALL output (60 lines — taller than the whole 24-row screen)
 * must FORCE-COMMIT the oldest live lines — the live region never
 * exceeds H−1, and the screen stays coherent: the first lines scroll
 * into the native scrollback (the emulator's grid — the scrollback),
 * the last lines stay visible, each exactly once (no ghost), and the
 * chrome sits intact at the bottom. The compositor's unit tests assert
 * the cap SCALAR directly (liveCount() ≤ H−1); this gate pins the
 * SCREEN consequence through the PTY + the VT emulator.
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

def driver(cli, env, feeds, timeout):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execvp("node", ["node", cli, "chat"])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
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
    sys.stdout.write(full.hex())
    sys.exit(0)
`;

describe("TUI v6 — the live-region cap (real PTY, the VT emulator)", () => {
	it("a 60-line output force-commits: the early lines scroll INTO the scrollback, the last lines stay, each once, the chrome intact", () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-v6-cap-"));
		const script = join(dir, "faux.json");
		const tall = Array.from({ length: 60 }, (_, i) => `tall line ${String(i + 1).padStart(2, "0")}`).join("\n");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						{ type: "text_delta", text: tall },
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
driver(${JSON.stringify(CLI)}, ${JSON.stringify({ ...env, KISO_FAUX_SCRIPT: script })}, ${JSON.stringify([["▌ ", "go\n"]])}, 30)
`;
		const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
		const emu = new VtScreen(24, 80);
		emu.write(Buffer.from(out, "hex"));
		const grid = emu.visible();
		// ① the FIRST lines left the grid — they scrolled into the
		//    scrollback (the force-commit — the live cap held).
		expect(grid.some((l) => l.includes("tall line 01"))).toBe(false);
		// ② the LAST lines are still visible — the output did not vanish.
		expect(grid.some((l) => l.includes("tall line 60"))).toBe(true);
		// ③ every visible line exactly once — the force-commit never ghosts.
		for (const row of grid) {
			if (row.includes("tall line")) expect(grid.filter((l) => l === row).length).toBe(1);
		}
		// ④ the visible output fits the content region (≤ H−4 = 20 rows —
		//    the live cap H−1 minus the 3 chrome rows).
		const tallRows = grid.filter((l) => l.includes("tall line")).length;
		expect(tallRows).toBeLessThanOrEqual(20);
		// ⑤ the chrome sits intact at the bottom (V6-3: the four rows —
		// box top, input, box bottom, status — the grid is 0-based; W6: the
		// ╌ rails became the box corners).
		expect(grid[20]!.includes("╭")).toBe(true);
		expect(grid[21]).toContain("› ");
		expect(grid[22]!.includes("╰")).toBe(true);
		expect(grid[23]).toContain("▸ default");
	}, 90_000);
});
