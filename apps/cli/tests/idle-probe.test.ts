/**
 * #14 (P1) — the idle-probe gate: after one complete round, the session
 * sits idle ≥8s and the terminal MUST stay quiet. The defect it pins:
 * the 200ms heartbeat re-painted the tail + the dock with zero change
 * (measured: 12s idle = 61 copies / 47KB — and the same re-push tore the
 * native scrollback). The fix: the idle heartbeat paints NOTHING — an
 * idle body has no glyph/elapsed to advance.
 *
 * Assertions: the idle window's bytes < 2KB (was ~73KB), the round's
 * terminal response appears EXACTLY once (no re-emission), and the idle
 * bytes contain NO real LF (zero scroll — nothing is pushed into the
 * scrollback) and no dangling CSI.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, env, workdir, idle_secs):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.chdir(workdir)
        os.execvp("node", ["node", cli, "chat", "idle-probe"])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    out = b""
    full = b""
    def read_until(needle, timeout):
        nonlocal out, full
        end = time.time() + timeout
        while time.time() < end:
            if needle in out:
                out = out[out.index(needle) + len(needle):]
                return True
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    d = os.read(fd, 4096)
                    out += d
                    full += d
                except OSError:
                    return False
        return False
    read_until(b"you> ", 20)
    os.write(fd, b"go\\n")
    read_until(b"idle done", 30)
    # The idle window: nothing fed, everything collected.
    end = time.time() + idle_secs
    idle = b""
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                d = os.read(fd, 4096)
                idle += d
                full += d
            except OSError:
                break
    os.write(fd, b"exit\\n")
    time.sleep(0.5)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    # idle bytes + the whole stream, both out on stdout as hex (exact)
    sys.stdout.write("IDLE=" + idle.hex() + "\\n")
    sys.stdout.write("FULL=" + full.hex() + "\\n")
    sys.exit(0)
`;

describe("#14 idle probe (real PTY, 24×80) — the idle heartbeat paints NOTHING", () => {
	it("8s idle after one round: <2KB, the response exactly once, no LF, no dangling CSI", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-idle-probe-"));
		const workdir = join(dir, "work");
		mkdirSync(workdir, { recursive: true });
		writeFileSync(join(workdir, "notes.txt"), "hi", "utf8");
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						{ type: "tool_call_end", callId: "r1", name: "read_file", input: { path: "notes.txt" } },
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "text_delta", text: "idle done" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const driverPath = join(dir, "driver.py");
		writeFileSync(driverPath, PTY_DRIVER, "utf8");
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script });
		const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(workdir)}, 8)
`;
		const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
		const idle = Buffer.from(/IDLE=(.*)\n/.exec(out)![1]!, "hex").toString("binary");
		const full = Buffer.from(/FULL=(.*)\n/.exec(out)![1]!, "hex").toString("binary");
		// ① the idle window stays quiet — was ~73KB before the fix.
		expect(idle.length).toBeLessThan(2048);
		// ② the round's terminal response appears EXACTLY once.
		expect((full.match(/idle done/g) ?? []).length).toBe(1);
		// ③ zero push: no real LF in the idle window (nothing scrolls,
		//    nothing enters the native scrollback).
		expect(idle.includes("\n")).toBe(false);
		// ④ no dangling CSI — every ESC opens a complete sequence.
		const esces = idle.match(/\x1b/g) ?? [];
		const csis = idle.match(/\x1b\[/g) ?? [];
		expect(esces.length).toBe(csis.length);
	}, 90_000);
});
