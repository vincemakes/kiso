/**
 * The /resume + /clear round (the approved joint mini-spec).
 *
 * The capability both commands share: chat() can END WITH A SWITCH
 * DIRECTIVE and main re-enters it on another session — the editor
 * survives, the durable law is untouched.
 *
 *  /clear  — a FRESH session id; the old session stays on disk,
 *            resumable (clear means "new conversation", never "erase
 *            history" — the append-only law does not move).
 *  /resume — the in-session door to the EXISTING picker machinery;
 *            /resume <id> switches directly; the projection the new
 *            session's next request sees carries ITS OWN history.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

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
	const dir = mkdtempSync(join(tmpdir(), "kiso-rc-"));
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

describe("/clear — a fresh conversation, history untouched", () => {
	it("switches to a new session id; the OLD durable log survives intact; the new one starts empty", () => {
		const { env, dirs } = isolatedEnv();
		const workdir = mkdtempSync(join(tmpdir(), "kiso-rc-w1-"));
		const out = strip(
			ptyRun(["chat", "first-conv"], env, [
				["› ", "hello there\r"],
				["What would you like me to inspect", "/clear\r"], // the faux script's turn-1 reply — a SETTLED anchor (the spinner shares the recap glyph)
				// a turn IN the new session — a run-less session writes no
				// file by design (the E1 lazy-marker semantics), so the new
				// log materializes here
				["previous: first-conv", "fresh hello\r"],
				["fresh hello", "exit\r"],
			], workdir),
		);
		expect(out).toContain("session first-conv");
		expect(out).toContain("previous: first-conv");
		// the old durable log is INTACT (clear never erases history) and
		// the new turn never leaked into it
		const old = readFileSync(join(dirs.home, "sessions", "first-conv.jsonl"), "utf8");
		expect(old).toContain("hello there");
		expect(old).not.toContain("fresh hello");
		// the NEW session's log exists and carries ITS turn
		const files = execFileSync("ls", [join(dirs.home, "sessions")], { encoding: "utf8" });
		const jsonls = files.split("\n").filter((f) => f.endsWith(".jsonl"));
		expect(jsonls.length).toBeGreaterThanOrEqual(2);
		const fresh = jsonls.find((f) => f !== "first-conv.jsonl")!;
		expect(readFileSync(join(dirs.home, "sessions", fresh), "utf8")).toContain("fresh hello");
	});
});

describe("/resume — the in-session door", () => {
	it("/resume <id> switches back; the resumed session's projection carries its own history", () => {
		const { env, dirs } = isolatedEnv();
		const workdir = mkdtempSync(join(tmpdir(), "kiso-rc-w2-"));
		const out = strip(
			ptyRun(["chat", "conv-a"], env, [
				["› ", "alpha turn\r"],
				["What would you like me to inspect", "/clear\r"],
				["previous: conv-a", "/resume conv-a\r"],
				["session conv-a (switched", "exit\r"],
			], workdir),
		);
		expect(out).toContain("session conv-a (switched");
		// conv-a's log still ends where it ended — the switch appended nothing
		const log = readFileSync(join(dirs.home, "sessions", "conv-a.jsonl"), "utf8");
		expect(log).toContain("alpha turn");
	});

	it("/resume to an UNKNOWN id refuses loudly — a switch never silently creates a session", () => {
		const { env, dirs } = isolatedEnv();
		const workdir = mkdtempSync(join(tmpdir(), "kiso-rc-w3-"));
		const out = strip(
			ptyRun(["chat", "conv-b"], env, [
				["› ", "/resume no-such-session\r"],
				["no such session", "exit\r"],
			], workdir),
		);
		expect(out).toContain("no such session: no-such-session");
		expect(existsSync(join(dirs.home, "sessions", "no-such-session.jsonl"))).toBe(false);
	});

	it("bare /resume with no other sessions says so instead of opening an empty picker", () => {
		const { env } = isolatedEnv();
		const workdir = mkdtempSync(join(tmpdir(), "kiso-rc-w4-"));
		const out = strip(
			ptyRun(["chat", "lonely"], env, [
				["› ", "/resume\r"],
				["no other sessions", "exit\r"],
			], workdir),
		);
		expect(out).toContain("no other sessions");
	});
});

describe("the guard no longer fires for the two new commands", () => {
	it("/clear is a command now — never 'unknown command'", () => {
		const { env } = isolatedEnv();
		const workdir = mkdtempSync(join(tmpdir(), "kiso-rc-w5-"));
		const out = strip(
			ptyRun(["chat", "guard-check"], env, [
				["› ", "/clear\r"],
				["previous: guard-check", "exit\r"],
			], workdir),
		);
		expect(out).not.toContain("unknown command: /clear");
	});
});
