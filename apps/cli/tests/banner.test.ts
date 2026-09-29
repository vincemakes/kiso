/**
 * The banner — the startup opening (Graphite §7.10). TTY only: pipes,
 * e2e drivers, and CI see byte-for-byte the historical output (the
 * existing e2e assertions are untouched — this is the proof). The piped
 * half of this test pins the absence; the PTY half pins the forms:
 *   ≥ 30 rows and room for the wordmark → the wordmark, the facts beside
 *     it from 96 columns and below it under
 *   anything shorter or narrower → one line, the facts below it
 * The driver sets an explicit winsize — a raw PTY reports 0x0.
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
        os.environ["KISO_SESSIONS_DIR"] = os.path.join(home, "sessions")  # 0.40.0: the pin follows the home
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
        if not sent and "/mode to switch".encode() in out:
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

/** R2: the banner styles itself per span now — the name is bold and the
 *  version beside it is dim — so the RAW transcript carries SGR between
 *  them and a substring match on the pair fails on bytes that are
 *  correct. Every assertion below reads the stripped text, which is what
 *  a human sees. */
function plainOut(env: NodeJS.ProcessEnv, home: string, rows: number, cols: number): string {
	// eslint-disable-next-line no-control-regex
	return ptyBanner(env, home, rows, cols).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

describe("the startup banner (logo)", () => {
	/**
	 * Graphite §7.10 — DECLARED REVERSAL of the R2 supersession
	 * (2026-08-27) this file used to pin: "no art and no tier", "answers
	 * the three questions" (MODEL / WORKSPACE / EXTENSIONS), and "the keys
	 * row". The Graphite round (owner-ruled 2026-09-28) brought the
	 * wordmark back for tall terminals and moved the answers: the model and
	 * the folder to the status bar, what loaded beside the wordmark, the
	 * keys to the empty input. The pipe half below is unchanged: a pipe
	 * sees none of it.
	 */
	it("a tall, wide terminal: the wordmark, the tagline, and what loaded beside it", () => {
		const { env, dirs } = isolatedEnv();
		const out = plainOut(env, dirs.home, 40, 100);
		expect(out).toContain("██╗  ██╗██╗███████╗ ██████╗");
		expect(out).toMatch(/the coding agent that survives kill -9 · \d+\.\d+\.\d+/);
		expect(out).toContain("intent → effect → durable fact");
		expect(out).toMatch(/│ {2}SESSION {5}new · resumable after kill -9/);
		expect(out).toMatch(/│ {2}RULES {7}none/);
		for (const gone of ["MODEL", "WORKSPACE", "esc interrupt"]) expect(out, gone).not.toContain(gone);
	}, 90_000);

	it("under 30 rows the opening is one line, and what loaded follows it", () => {
		const { env, dirs } = isolatedEnv();
		for (const [rows, cols] of [
			[24, 80],
			[29, 120],
			[10, 80],
		] as const) {
			const out = plainOut(env, dirs.home, rows, cols);
			expect(out, `${rows}x${cols}`).not.toContain("█");
			expect(out, `${rows}x${cols}`).toMatch(/✦ kiso \d+\.\d+\.\d+ · the coding agent that survives kill -9/);
		}
		expect(plainOut(env, dirs.home, 24, 80)).toMatch(/SESSION {5}new · resumable after kill -9/);
	}, 90_000);

	it("a narrow screen keeps the name and drops nothing silently", () => {
		const { env, dirs } = isolatedEnv();
		const narrow = plainOut(env, dirs.home, 40, 31);
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
