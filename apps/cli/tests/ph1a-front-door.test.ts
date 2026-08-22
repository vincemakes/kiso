/**
 * PH-1a — the front-door correctness batch, e2e against the BUILT CLI.
 *
 * (1) finding PH-F2: `--help`/`-h`/`--version`/`-v` are FLAGS — they used
 *     to fall through the default case and START A SESSION literally named
 *     "--help" (writing ~/.kiso/sessions/--help.jsonl).
 * (2) finding PH-F1: an unrecognized slash command is an ERROR, never a
 *     turn — the fallthrough used to hand "/bogus" to the model, burning a
 *     request on text the user meant as a command.
 * (3) finding PH-F4: the /model panel's zero-profile hint must be a syntax
 *     directWriteProfile actually accepts (`openai-compat/…`, never the
 *     old `openai/…` that failed with "no such model profile" on exactly
 *     the fresh-install path that shows it).
 * (4) finding PH-F8 (P0): the /model switch is ATOMIC — the NEXT request
 *     carries the NEW model id to the NEW adapter. Proven against a live
 *     openai-compat SSE stub that records every request body's `model`:
 *     the pre-fix CLI swapped the adapter but the session's frozen config
 *     kept sending the OLD model id (the UI claimed one model, the wire
 *     carried another).
 */

import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { isolatedEnv, runCli, stripANSI } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, env, feeds, workdir, timeout):
    pid, fd = pty.fork()
    if pid == 0:
        # PH-F5 isolation: the host's NO_COLOR must not leak into the child
        if "NO_COLOR" not in env:
            os.environ.pop("NO_COLOR", None)
        os.environ.update(env)
        os.chdir(workdir)
        os.execvp("node", ["node", cli, "chat"])
    def winsize(rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    winsize(24, 100)
    full = b""
    fed = set()
    end = time.time() + timeout
    done = False
    while time.time() < end and not done:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                done = True
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

function ptyPhase(env: NodeJS.ProcessEnv, feeds: [string, string][], workdir: string, timeout: number): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-ph1a-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	return `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${JSON.stringify(workdir)}, ${timeout})
`;
}

function ptyRun(env: NodeJS.ProcessEnv, feeds: [string, string][], workdir: string, timeout = 40): string {
	return execFileSync("python3", ["-c", ptyPhase(env, feeds, workdir, timeout)], { encoding: "utf8", timeout: 90_000, env: process.env });
}

/** The ASYNC variant for tests that host an in-process stub server: a
 *  sync execFileSync would block the vitest event loop, so the stub could
 *  never answer the PTY child's requests — the deadlock this file hit
 *  first-hand before this helper existed. */
function ptyRunAsync(env: NodeJS.ProcessEnv, feeds: [string, string][], workdir: string, timeout = 40): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("python3", ["-c", ptyPhase(env, feeds, workdir, timeout)], { env: process.env });
		let out = "";
		child.stdout.on("data", (d: Buffer) => {
			out += d.toString();
		});
		child.stderr.on("data", (d: Buffer) => {
			out += d.toString();
		});
		const killer = setTimeout(() => child.kill("SIGKILL"), 90_000);
		child.on("exit", () => {
			clearTimeout(killer);
			resolve(out);
		});
		child.on("error", reject);
	});
}

/** The session files under an isolated home — [] when the dir was never
 *  created (a flags-only invocation must create NOTHING). */
function sessionFiles(home: string): string[] {
	const dir = join(home, "sessions");
	return existsSync(dir) ? readdirSync(dir) : [];
}

describe("PH-F2 — --help/--version are flags, never session ids", () => {
	it("kiso --help prints the help and starts NOTHING", () => {
		const { env, dirs } = isolatedEnv();
		const r = runCli(["--help"], env, { input: "" });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("kiso [sessionId]");
		expect(r.stdout).toContain("kiso sessions");
		expect(sessionFiles(dirs.home)).toEqual([]);
	});

	it("kiso -h is the same door", () => {
		const { env, dirs } = isolatedEnv();
		const r = runCli(["-h"], env, { input: "" });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("kiso [sessionId]");
		expect(sessionFiles(dirs.home)).toEqual([]);
	});

	it("kiso --version prints the version alone and starts NOTHING", () => {
		const { env, dirs } = isolatedEnv();
		const r = runCli(["--version"], env, { input: "" });
		expect(r.status).toBe(0);
		expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
		expect(sessionFiles(dirs.home)).toEqual([]);
	});

	it("kiso -v is the same door", () => {
		const { env, dirs } = isolatedEnv();
		const r = runCli(["-v"], env, { input: "" });
		expect(r.status).toBe(0);
		expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
		expect(sessionFiles(dirs.home)).toEqual([]);
	});
});

describe("PH-F1 — an unknown slash command errors, never reaches the model", () => {
	it("pipe: /bogus prints the error and consumes NO scripted turn", () => {
		const { env } = isolatedEnv();
		const r = runCli(["chat", "unknown-cmd"], env, { input: "/bogus something\nexit\n" });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("unknown command: /bogus — /help lists the commands");
		// the faux script's demo turns were never consumed: no assistant
		// text landed, and the exhaustion error never fired.
		expect(r.stdout).not.toContain("[faux mode] the scripted demo turns are exhausted");
	});

	it("a multi-line paste that merely begins with '/' is prose and still submits", () => {
		const { env } = isolatedEnv();
		const r = runCli(["chat", "slash-paste"], env, { input: "/etc/hosts has an entry\nexit\n" });
		// single-line, starts with "/": treated as a command — this is the
		// documented trade (a one-line path mention becomes an error, a
		// paste with newlines still flows). The pipe path feeds line-wise,
		// so the single-line case is what it exercises.
		expect(r.stdout).toContain("unknown command: /etc/hosts");
	});
});

describe("PH-F4 — the zero-profile /model hint uses accepted syntax", () => {
	it("the panel's example is openai-compat/…, which directWriteProfile accepts", () => {
		const { env } = isolatedEnv();
		const workdir = mkdtempSync(join(tmpdir(), "kiso-ph1a-f4-"));
		const out = stripANSI(
			ptyRun(env, [
				["› ", "/model\r"],
				["deepseek-reasoner", "\x1bexit\r"], // esc leaves the panel first
			], workdir),
		);
		expect(out).toContain("openai-compat/deepseek-reasoner");
		expect(out).not.toContain("(e.g. openai/deepseek-reasoner)");
	});
});

describe("PH-F8 (P0) — the /model switch is atomic on the wire", () => {
	const seenModels: string[] = [];
	let server: Server;
	let port = 0;

	const startStub = async (): Promise<void> => {
		server = createServer((req, res) => {
			let body = "";
			req.on("data", (c) => {
				body += c;
			});
			req.on("end", async () => {
				const parsed = JSON.parse(body) as { model: string };
				seenModels.push(parsed.model);
				// "slow-model" holds the turn open long enough for a human (or
				// a feed) to act MID-RUN — the PH-F11 test's window.
				if (parsed.model === "slow-model") await new Promise((r) => setTimeout(r, 1500));
				res.writeHead(200, { "content-type": "text/event-stream" });
				const chunk = (obj: unknown): void => {
					res.write(`data: ${JSON.stringify(obj)}\n\n`);
				};
				chunk({
					id: "c1",
					object: "chat.completion.chunk",
					created: 0,
					model: parsed.model,
					choices: [{ index: 0, delta: { role: "assistant", content: `reply-from-${parsed.model}` }, finish_reason: null }],
				});
				chunk({
					id: "c1",
					object: "chat.completion.chunk",
					created: 0,
					model: parsed.model,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				});
				res.write("data: [DONE]\n\n");
				res.end();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		port = (server.address() as AddressInfo).port;
	};

	afterAll(() => {
		server?.close();
	});

	it("the request AFTER the switch carries the NEW model id — the wire, not the status row, is the proof", async () => {
		await startStub();
		const { env, dirs } = isolatedEnv();
		const base = `http://127.0.0.1:${port}`;
		env.OPENAI_API_KEY = "sk-fake";
		env.OPENAI_BASE_URL = base;
		env.OPENAI_MODEL = "alpha-model";
		writeFileSync(
			join(dirs.home, "config.json"),
			JSON.stringify({ models: { beta: { kind: "openai-compat", model: "beta-model", apiKeyEnv: "OPENAI_API_KEY", baseUrl: base } } }),
			"utf8",
		);
		const workdir = mkdtempSync(join(tmpdir(), "kiso-ph1a-f8-"));
		const out = stripANSI(
			await ptyRunAsync(env, [
				["› ", "hello\r"],
				["reply-from-alpha-model", "/model beta\r"],
				["takes effect on the next turn", "again\r"],
				["reply-from-beta-model", "exit\r"],
			], workdir, 60),
		);
		// the pre-fix CLI: seenModels === ["alpha-model", "alpha-model"] —
		// the adapter changed, the wire's model id did not.
		expect(seenModels).toEqual(["alpha-model", "beta-model"]);
		expect(out).toContain("reply-from-beta-model");
	});

	it("PH-F11 — `exit` typed MID-RUN queues the close: the run finishes, the reply lands, THEN the REPL exits", async () => {
		await startStub();
		const before = seenModels.length;
		const { env } = isolatedEnv();
		env.OPENAI_API_KEY = "sk-fake";
		env.OPENAI_BASE_URL = `http://127.0.0.1:${port}`;
		env.OPENAI_MODEL = "slow-model"; // the stub holds this turn open ~1.5s
		const workdir = mkdtempSync(join(tmpdir(), "kiso-ph1a-f11-"));
		const out = stripANSI(
			await ptyRunAsync(env, [
				["› ", "hello\r"],
				// "working" is the in-flight status row — the exit lands MID-RUN.
				// The pre-fix CLI closed the input surface immediately (the v2b
				// "readline was closed" edge) and the reply was lost.
				["working", "exit\r"],
			], workdir, 30),
		);
		expect(out).toContain("[exit queued — closing after the current run completes]");
		expect(out).toContain("reply-from-slow-model");
		expect(seenModels.length).toBe(before + 1);
	});
});
