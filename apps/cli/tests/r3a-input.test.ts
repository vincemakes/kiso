/**
 * R3a — the input quartet (the light half of the R3 spec).
 *
 *  1. -p/--print: the one-shot prompt mode — stdout carries the run,
 *     the exit code is 0 only on a `completed` terminal.
 *  2. cross-session history: ~/.kiso/history — a line submitted in one
 *     process recalls with ↑ in the next.
 *  3. Shift+Tab (CSI Z) cycles the approval tier at the composer.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, argv, env, feeds, workdir, timeout):
    pid, fd = pty.fork()
    if pid == 0:
        if "NO_COLOR" not in env:
            os.environ.pop("NO_COLOR", None)
        os.environ.update(env)
        os.chdir(workdir)
        os.execvp("node", ["node", cli] + argv)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
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

function ptyRun(argv: string[], env: NodeJS.ProcessEnv, feeds: [string, string][], workdir: string, timeout = 40): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-r3a-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(argv)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${JSON.stringify(workdir)}, ${timeout})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
}

const strip = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

describe("R3a — -p/--print one-shot", () => {
	it("runs one turn, prints the run, exits 0 on completed", () => {
		const { env } = isolatedEnv();
		const r = runCli(["-p", "hello one-shot"], env, { input: "" });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("faux model"); // the scripted reply reached stdout
	});

	it("a bare -p with no prompt is a loud usage error, exit 2", () => {
		const { env } = isolatedEnv();
		const r = runCli(["-p"], env, { input: "" });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("usage: kiso -p");
	});
});

describe("R3a — cross-session history", () => {
	it("a submitted line persists to ~/.kiso/history and recalls with ↑ in the NEXT process", () => {
		const { env, dirs } = isolatedEnv();
		const workdir = mkdtempSync(join(tmpdir(), "kiso-r3a-h-"));
		// process 1: submit a distinctive line, exit
		strip(ptyRun(["chat", "hist-one"], env, [
			["› ", "remember this exact line\r"],
			["What would you like me to inspect", "exit\r"],
		], workdir));
		const file = readFileSync(join(dirs.home, "history"), "utf8");
		expect(file).toContain("remember this exact line");
		// process 2: ↑ on the empty composer recalls it
		const out2 = strip(ptyRun(["chat", "hist-two"], env, [
			["› ", "\x1b[A"],
			["remember this exact line", "\x1b[B\rexit\r"], // walk back down, submit nothing meaningful, exit
		], workdir));
		expect(out2).toContain("remember this exact line");
	});
});

describe("R3a — Shift+Tab cycles the tier", () => {
	it("CSI Z at the composer flips default → accept-edits, with the notice", () => {
		const { env } = isolatedEnv();
		const workdir = mkdtempSync(join(tmpdir(), "kiso-r3a-st-"));
		// the cycle callback registers inside chat() — a CSI Z fired at the
		// BOOT frame's prompt would race it; the settled first turn is the
		// REPL-ready anchor
		const out = strip(ptyRun(["chat", "st-one"], env, [
			["› ", "hi\r"],
			["What would you like me to inspect", "\x1b[Z"],
			["mode → accept-edits", "exit\r"],
		], workdir));
		expect(out).toContain("mode → accept-edits (shift+tab cycles)");
	});
});
