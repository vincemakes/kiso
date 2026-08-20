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
	it("COMPACT (15x80): the 2-row wordmark appears with the version line — the W1 selection is a height input (VD-14: one wordmark, both tiers)", () => {
		const { env, dirs } = isolatedEnv();
		const out = ptyBanner(env, dirs.home, 15, 80);
		expect(out).toContain("█ █ ▀█▀ █▀▀ █▀█");
		expect(out).toContain("the coding agent that survives kill -9");
		expect(out).toContain("█▀▄ ▄█▄ ▄▄█ █▄█");
		expect(out).toMatch(/v\d+\.\d+\.\d+/); // the version rides the info row
	}, 90_000);

	it("BIG (24x80): the SAME 2-row wordmark — VD-14 retired the 36x6 pixel art (its mid-scroll cut rendered glyph garbage)", () => {
		const { env, dirs } = isolatedEnv();
		const out = ptyBanner(env, dirs.home, 24, 80);
		expect(out).toContain("█ █ ▀█▀ █▀▀ █▀█");
		expect(out).not.toContain("██████  ████████");
		expect(out).toContain("the coding agent that survives kill -9");
		// the art is the wordmark — the text row does NOT repeat the name
		expect(out).not.toMatch(/kiso v\d+\.\d+\.\d+/);
		expect(out).toMatch(/v\d+\.\d+\.\d+ — the coding agent/);
	}, 90_000);

	it("text rows only (24x39, and 10x80): no logo at any size below the tiers", () => {
		const { env, dirs } = isolatedEnv();
		const narrow = ptyBanner(env, dirs.home, 24, 39);
		expect(narrow).not.toContain("█");
		// at 39 the version row itself truncates (with the marker) — the
		// tier's identity is the absence of art, not a full row
		expect(narrow).toMatch(/v\d+\.\d+\.\d+ — the coding agent/);
		const short = ptyBanner(env, dirs.home, 10, 80);
		expect(short).not.toContain("█");
		expect(short).toContain("the coding agent that survives kill -9");
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
