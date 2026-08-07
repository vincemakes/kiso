/**
 * TUI v6 (ADR-0046) — the idle-chrome gate: the input row's SCREEN
 * position while typing. The V6-3 four-row chrome (upper ╌ at H−3,
 * the input at H−2, the lower ╌ at H−1, the status at H) must survive
 * the STEADY frames. The no-commit path (a frame with zero NEW commits
 * — every keystroke after the first, once the banner committed) jumped
 * ONE row from the anchor and repainted the chrome one row up: the
 * status landed at H−1 and the input box shifted up (the real-machine
 * report on 0.1.33). The compositor's unit gate pins the byte (the 2B
 * jump); this gate pins the SCREEN (rows 21..24 of 24) with TWO feeds —
 * the first input's frame still commits the banner (the committed
 * path, correct); the SECOND input's frame takes the no-commit path.
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
    t0 = time.time()
    end = t0 + timeout
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            full += data
        for i, (needle, text, delay) in enumerate(feeds):
            if i not in fed and time.time() - t0 >= delay and needle.encode() in full:
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

describe("TUI v6 — the idle chrome (real PTY, the VT emulator)", () => {
	it("while typing the CJK char twice with no commits in between, the steady chrome still sits on H−3/H−2/H−1/H — the input row never shifts up", () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-v6-idle-"));
		const script = join(dir, "faux.json");
		// an EMPTY turn — zero cells: the ONLY commits are the banner's
		// (frame 1); every later input frame takes the no-commit path.
		writeFileSync(script, JSON.stringify([{ events: [] }]), "utf8");
		const driverPath = join(dir, "driver.py");
		writeFileSync(driverPath, PTY_DRIVER, "utf8");
		const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify({ ...env, KISO_FAUX_SCRIPT: script })}, ${JSON.stringify([
			["▌ ", "\u4f60", 2],
			["▌ ", "\u4f60", 3],
		])}, 10)
`;
		const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
		const emu = new VtScreen(24, 80);
		emu.write(Buffer.from(out, "hex"));
		const grid = emu.visible();
		// the V6-3 chrome on the FINAL grid (0-based rows): upper ╌ at
		// H−3 (20), the input at H−2 (21), the lower ╌ at H−1 (22), the
		// status at H (23) — the buggy no-commit frame put the input at 20
		// and the status at 22 (the input box shifted one row up).
		expect(grid[20]!.includes("╌")).toBe(true);
		expect(grid[21]!.includes("▌ ")).toBe(true);
		expect(grid[21]).toContain("\u4f60");
		expect(grid[22]!.includes("╌")).toBe(true);
		// the status at H — the idle hint (the CLI's empty status + the
		// right-aligned "/ commands · ↑ history" tail).
		expect(grid[23]).toContain("/ commands");
	}, 90_000);
});
