/**
 * v2a — the interactive TUI through the CLI's topmost entry, on a REAL
 * PTY: the typed input is echoed by readline itself and NEVER rendered
 * again (双回显); the status line is the faux form; the rhythm gap lands
 * between the status and the next prompt; the prompt carries the blue
 * accent.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** The python PTY driver: feed each (needle, text) pair once when the
 *  needle appears; whatever the CLI wrote — including the terminal's own
 *  echo — lands in the transcript for the byte assertions. */
const PTY_DRIVER = `
import pty, os, sys, time, select, signal

def driver(cli, env, cwd, feeds, timeout):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.chdir(cwd)
        os.execvp("node", ["node", cli, "chat"])
    out = b""
    full = b""
    fed = set()
    end = time.time() + timeout
    done = False
    while time.time() < end and not done:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                done = True
                break
            out += data
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

function ptyRun(env: NodeJS.ProcessEnv, feeds: [string, string][]): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-v2a-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(dir)}, ${JSON.stringify(feeds)}, 40)
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
}

describe("TUI v2a (real PTY)", () => {
	it("no double echo — the typed input appears exactly once; status is [turn N · faux]; the rhythm gap separates done from the prompt", () => {
		const { env } = isolatedEnv();
		const out = ptyRun(env, [
			["you> ", "probe-one\n"],
			["you> ", "exit\n"],
		]);
		// ① 双回显: readline echoed "probe-one" — the user_input event render
		// must NOT print it again. The content appears exactly once.
		expect((out.match(/probe-one/g) ?? []).length).toBe(1);
		// The prompt + echo read "you> probe-one" once — readline's redraw
		// control sequences sit between them in the raw transcript, so count
		// on the control-stripped stream.
		const clean = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
		expect((clean.match(/you> probe-one/g) ?? []).length).toBe(1);
		// ② the blue accent rides the prompt.
		expect(out).toContain("\x1b[38;5;75m");
		// ③ faux status form.
		expect(out).toMatch(/\[turn \d+ · faux\]/);
		// ④ rhythm: done, then the status hugging it, then exactly one blank
		// line before the next prompt (the pty cooks \n into \r\n).
		expect(out).toContain("done\r\n[turn 2 · faux]\r\n\r\n");
	}, 90_000);
});
