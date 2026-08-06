/**
 * The banner — the block-letter startup logo. TTY only: pipes, e2e drivers, and
 * CI see byte-for-byte the historical output (the existing e2e assertions
 * are untouched — this is the proof). The piped half of this test pins the
 * absence; the PTY half pins the presence.
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
import pty, os, sys, time, select

def driver(cli, home):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["KISO_HOME"] = home
        os.execvp("node", ["node", cli, "chat", "banner-t"])
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
        if not sent and "▌ ".encode() in out:
            os.write(fd, b"exit\\n")
            sent = True
    sys.stdout.write(full.decode(errors="replace"))
    sys.exit(0)
`;

describe("the startup banner (logo)", () => {
	it("TTY: the three logo rows appear with the version line", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-banner-"));
		writeFileSync(join(dir, "driver.py"), PTY_DRIVER, "utf8");
		const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(dir, "driver.py"))}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(dirs.home)})
`;
		const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 60_000, env });
		expect(out).toContain("█ █ ▀█▀ █▀▀ █▀█");
		expect(out).toContain("the coding agent that survives kill -9");
		expect(out).toContain("▀ ▀ ▀▀▀ ▀▀▀ ▀▀▀");
		expect(out).toMatch(/v0\.1\.\d+/); // the version rides the third row
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
