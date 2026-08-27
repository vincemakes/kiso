/**
 * The banner — the block-letter startup logo, three tiers (W1). TTY
 * only: pipes, e2e drivers, and CI see byte-for-byte the historical
 * output (the existing e2e assertions are untouched — this is the
 * proof). The piped half of this test pins the absence; the PTY half
 * pins the presence at every tier:
 *   ≥ 40 cols and ≥ 20 rows → BIG (the 36x6 wordmark)
 *   ≥ 40 cols and 14–19 rows → COMPACT (v6's logo — the existing
 *     literal stays valid for this tier)
 *   anything smaller → text rows only
 * The driver sets an explicit winsize — a raw PTY reports 0x0, which
 * is the text-only tier, so the COMPACT assertions need the height.
 */

import { execFileSync } from "node:child_process";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const PTY_DRIVER = `
import pty, os, sys, time, select, fcntl, termios, struct

def driver(cli, home, rows, cols):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["KISO_HOME"] = home
        os.execvp("node", ["node", cli, "chat", "banner-t"])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    out = b""
    full = b""
    end = time.time() + 15
    sent = False
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                data = os.read(fd, 4096)
                if not data:
                    break
                out += data
                full += data
            except OSError:
                break
        if not sent and "› ".encode() in out:
            os.write(fd, b"exit\\r")
            sent = True
    sys.stdout.write(full.decode(errors="replace"))
    sys.exit(0)
`;

function ptyBanner(env: NodeJS.ProcessEnv, home: string, rows: number, cols: number): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-banner-"));
	writeFileSync(join(dir, "driver.py"), PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(dir, "driver.py"))}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(home)}, ${rows}, ${cols})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 60_000, env });
}

describe("the startup banner (logo)", () => {
	/**
	 * R2 supersession (2026-08-27, the nineteen-screen review): the
	 * wordmark is retired, and the HEIGHT TIER retires with it.
	 *
	 * TT-1B had already cut the 36x6 pixel art to two rows because a tall
	 * banner's mid-scroll cut renders as glyph garbage. The last two rows
	 * go because they spell `kiso` in fifteen columns of block glyphs and
	 * the word spells it in four. A rendered clover mark was tried first,
	 * at four sizes, and rejected on measurement.
	 *
	 * The tagline goes with it. It was a claim the banner made about the
	 * product; the three labelled facts are answers to what a human at a
	 * fresh prompt actually needs — what model, where am I, what is
	 * loaded — and they are the same three at every height, which is one
	 * fewer state in a table whose states existed only to protect art.
	 */
	it("no art and no tier: the same rows at every height", () => {
		const { env, dirs } = isolatedEnv();
		for (const [rows, cols] of [
			[15, 80],
			[24, 80],
			[10, 80],
		] as const) {
			const out = ptyBanner(env, dirs.home, rows, cols);
			expect(out, `${rows}x${cols}`).not.toContain("█");
			expect(out, `${rows}x${cols}`).not.toContain("the coding agent that survives kill -9");
			expect(out, `${rows}x${cols}`).toMatch(/kiso \d+\.\d+\.\d+/);
		}
	}, 90_000);

	it("answers the three questions a first screen is asked", () => {
		const { env, dirs } = isolatedEnv();
		const out = ptyBanner(env, dirs.home, 24, 80);
		expect(out).toContain("MODEL");
		expect(out).toContain("WORKSPACE");
		expect(out).toContain("EXTENSIONS");
		expect(out).toContain("/ commands"); // the keys row
	}, 90_000);

	it("a narrow screen keeps the name and drops nothing silently", () => {
		const { env, dirs } = isolatedEnv();
		const narrow = ptyBanner(env, dirs.home, 24, 39);
		expect(narrow).not.toContain("█");
		expect(narrow).toMatch(/kiso \d+\.\d+\.\d+/);
	}, 90_000);

	it("piped: the logo is byte-for-byte ABSENT — the historical output shape is intact", () => {
		const { env } = isolatedEnv();
		const out = execFileSync("node", [CLI, "chat", "banner-p"], {
			input: "exit\n",
			encoding: "utf8",
			env,
			timeout: 30_000,
		});
		expect(out).not.toContain("█");
		expect(out).not.toContain("the coding agent that survives kill -9");
		expect(out).toContain("session banner-p");
	}, 60_000);
});
