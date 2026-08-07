/**
 * The lab's shared PTY driver — runs the CLI in a real pty (24×80),
 * feeds (needle, text) pairs once, returns the full byte stream.
 * Zero dependencies (node:child_process + python3).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(fileURLToPath(new URL("../../..", import.meta.url)), "apps", "cli", "dist", "index.js");

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, env, feeds, timeout):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execvp("node", ["node", cli, "chat"])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    full = b""
    fed = set()
    end = time.time() + timeout
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

/** Run the CLI with a faux script + the feeds; returns the transcript.
 *  `extensions` = { "<name>.mjs": "<source>" } — written into the ext dir. */
export function ptyRun({ events, feeds, timeout = 30, hex = false, extensions = {} }) {
	const dir = mkdtempSync(join(tmpdir(), "kiso-lab-"));
	const script = join(dir, "faux.json");
	writeFileSync(script, JSON.stringify(events), "utf8");
	mkdirSync(join(dir, "ext"), { recursive: true });
	for (const [name, source] of Object.entries(extensions)) {
		writeFileSync(join(dir, "ext", name), source, "utf8");
	}
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const env = { ...process.env, KISO_FAUX_SCRIPT: script, KISO_HOME: join(dir, "home"), KISO_EXTENSIONS_DIR: join(dir, "ext") };
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${timeout})
`;
	const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 120_000, env: process.env });
	return hex ? Buffer.from(out, "utf8") : out;
}

/** ANSI-strip a transcript. */
export function stripANSI(text) {
	return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
}
