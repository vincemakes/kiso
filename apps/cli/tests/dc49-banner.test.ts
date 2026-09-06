/**
 * DC-49 — the startup row, on a real terminal.
 *
 * The workspace being the home directory is ALLOWED (owner,
 * 2026-09-06): no refusal, no warning. What the product owes the user is
 * that they can TELL, and one sentence they can act on.
 *
 * A PTY, not a pipe. The first build of this gate used a pipe and could
 * not see the row at all — in a pipe the banner prints the extensions
 * line and nothing else, so MODEL and WORKSPACE (and therefore this row)
 * are absent by design. A gate that cannot observe its subject is not a
 * gate.
 *
 * The row must FIT at W=80 under the label indent. A cut row loses its
 * second half, and the second half — `cd into a project to narrow it` —
 * is the only part the reader can act on.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, stripANSI } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const ROW = "home directory as workspace";

const PTY_DRIVER = `
import pty, os, sys, time, select, fcntl, termios, struct

def driver(cli, home, cwd, rows, cols):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["HOME"] = home
        os.environ["KISO_HOME"] = os.path.join(home, ".kiso")
        os.environ["KISO_MODE"] = "bypass"
        os.chdir(cwd)
        os.execvp("node", ["node", cli, "chat", "dc49-banner"])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
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
                full += data
            except OSError:
                break
        if not sent and "/ commands".encode() in full:
            os.write(fd, b"exit\\r")
            sent = True
    sys.stdout.write(full.decode(errors="replace"))
    sys.exit(0)
`;

function bannerAt(home: string, cwd: string, cols = 80): string {
	const { env } = isolatedEnv();
	const dir = mkdtempSync(join(tmpdir(), "kiso-dc49-drv-"));
	writeFileSync(join(dir, "driver.py"), PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(dir, "driver.py"))}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(home)}, ${JSON.stringify(cwd)}, 24, ${cols})
`;
	return stripANSI(execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env }));
}

describe("DC-49 — the banner says when the workspace is home", () => {
	it("cwd IS home: the row appears, whole, and fits", () => {
		const home = mkdtempSync(join(tmpdir(), "kiso-dc49-home-"));
		const out = bannerAt(home, home);
		expect(out, "the row is absent at home").toContain(ROW);
		// the REMEDY survives — a cut row keeps the first half only
		expect(out, "the row was cut and lost the remedy").toContain("cd into a project to narrow it");
		const row = out.split(/\r?\n/).find((l) => l.includes(ROW)) ?? "";
		expect(row, "the row carries a cut marker").not.toContain("…");
	});

	it("cwd is a PROJECT under home: no row", () => {
		const home = mkdtempSync(join(tmpdir(), "kiso-dc49-home2-"));
		const proj = join(home, "project");
		mkdirSync(proj, { recursive: true });
		expect(bannerAt(home, proj), "the row appeared in a project").not.toContain(ROW);
	});

	it("a SYMLINKED home still matches — realpath on both sides", () => {
		// darwin's /tmp is a symlink to /private/tmp, so the raw strings
		// differ while the directory is the same. `mkdtemp` returns the
		// UNRESOLVED form, which is exactly the case a string compare slips
		// on — and the one a home directory on a symlinked volume hits.
		const home = mkdtempSync(join(tmpdir(), "kiso-dc49-link-"));
		expect(bannerAt(home, home)).toContain(ROW);
	});
});
