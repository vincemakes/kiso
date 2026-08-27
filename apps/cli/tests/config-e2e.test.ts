/**
 * Merge round B — the config surface e2e (BUILT CLI):
 * (1) /model on a real PTY with two profiles (one available via the env,
 *   one not) — the listing annotates availability, the switch refuses the
 *   unavailable one loudly and lands the available one's NoticeCell;
 * (2) the project .kiso/config.json rides the E3 trust gate — granted →
 *   the project's model appears, projectTrust "never" → no ask, nothing
 *   loads;
 * (3) the pipe path: an untrusted project config is never read (regression), and
 *   a broken USER config fails the process LOUDLY (non-zero, the file
 *   named) — a silently ignored config would mislead.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli, stripANSI } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, env, feeds, workdir, timeout):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.chdir(workdir)
        os.execvp("node", ["node", cli, "chat"])
    def winsize(rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    winsize(24, 80)
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

function ptyRun(env: NodeJS.ProcessEnv, feeds: [string, string][], workdir: string, timeout = 40): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-config-e2e-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${JSON.stringify(workdir)}, ${timeout})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
}

describe("merge round B — /model on a real PTY (dual profiles)", () => {
	it("lists profiles with availability; refuses the unavailable one; the switch lands the NoticeCell", () => {
		const { env, dirs } = isolatedEnv();
		writeFileSync(
			join(dirs.home, "config.json"),
			JSON.stringify({
				models: {
					ds: { kind: "openai-compat", model: "deepseek-v4-flash", apiKeyEnv: "MY_TEST_KEY" },
					claude: { kind: "anthropic", model: "claude-sonnet-5", apiKeyEnv: "ANTHROPIC_API_KEY" },
				},
			}),
			"utf8",
		);
		env.MY_TEST_KEY = "sk-fake"; // available (a NON-top-level env — the session stays faux)
		// ANTHROPIC_API_KEY deliberately unset → claude unavailable

		const workdir = mkdtempSync(join(tmpdir(), "kiso-config-e2e-w1-"));
		// MOVED (the picker-surface class, TUI2-R2 ④): bare /model was a
		// PRINTED list and a sentence telling you to go and edit a JSON
		// file; it is a picker panel now. The facts it shows are the same
		// facts, so the assertions move to the rows that carry them — and
		// the SWITCH is unchanged, which is what the second half proves:
		// picking option 2 resolves to exactly the argument `/model claude`
		// would have passed, and lands in exactly the same refusal.
		const out = stripANSI(
			ptyRun(env, [
				["/ commands · \u2191 history", "/model\r"],
				["digits pick", "2\r"],
				["not set", "/model ds\r"],
				["model → ds", "exit\r"],
			], workdir),
		);
		expect(out).toContain("model — current: faux"); // the panel's header, where "model: faux" used to print
		expect(out).toContain("openai-compat/deepseek-v4-flash");
		expect(out).toContain("profile: ds");
		expect(out).toContain("anthropic/claude-sonnet-5");
		expect(out).toContain("unavailable"); // the qualifier rides the row, as (unavailable) rode the line
		expect(out).toContain("model claude: unavailable — the env var ANTHROPIC_API_KEY is not set");
		expect(out).toContain("model → ds (deepseek-v4-flash) — takes effect on the next turn");
	});

	it("a direct provider/model write switches too", () => {
		const { env, dirs } = isolatedEnv();
		env.OPENAI_API_KEY = "sk-fake";
		const workdir = mkdtempSync(join(tmpdir(), "kiso-config-e2e-w2-"));
		const out = stripANSI(
			ptyRun(env, [
				["/ commands · \u2191 history", "/model openai-compat/gpt-4o\r"],
				["model → openai-compat/gpt-4o", "exit\r"],
			], workdir),
		);
		expect(out).toContain("model → openai-compat/gpt-4o (gpt-4o) — takes effect on the next turn");
	});
});

describe("merge round B — the project config rides the E3 trust gate", () => {
	it("granted → the project's model appears in the /model listing", () => {
		const { env, dirs } = isolatedEnv();
		env.MY_TEST_KEY = "sk-fake"; // non-top-level — the env layer stays silent, the config resolves
		const workdir = mkdtempSync(join(tmpdir(), "kiso-config-e2e-p1-"));
		mkdirSync(join(workdir, ".kiso"), { recursive: true });
		writeFileSync(
			join(workdir, ".kiso", "config.json"),
			JSON.stringify({ model: "proj-model", models: { "proj-model": { kind: "openai-compat", model: "proj-model-x", apiKeyEnv: "MY_TEST_KEY" } } }),
			"utf8",
		);
		const out = stripANSI(
			ptyRun(env, [
				["trust this project", "y\r"],
				["/ commands · \u2191 history", "/model\r"],
				// esc leaves the panel and the exit rides the SAME chunk: a
				// panel owns every printable key while it is up, so a bare
				// "exit" typed into one is swallowed by design
				["digits pick", "\x1bexit\r"],
			], workdir),
		);
		expect(out).toContain("trust this project's .kiso?"); // the trust panel's rule line (the "(y/n)" suffix is gone — the panel superseded the boxed question)
		// MOVED (the picker-surface class, TUI2-R2 ④): the same two facts,
		// on the panel's header and option row instead of two printed lines
		expect(out).toContain("model — current: proj-model-x"); // the project's model drives the session
		expect(out).toContain("openai-compat/proj-model-x");
		expect(out).toContain("profile: proj-model");
	});

	it("projectTrust \"never\" (user config) → no ask, nothing loads", () => {
		const { env, dirs } = isolatedEnv();
		env.OPENAI_API_KEY = "sk-fake";
		writeFileSync(join(dirs.home, "config.json"), JSON.stringify({ projectTrust: "never" }), "utf8");
		const workdir = mkdtempSync(join(tmpdir(), "kiso-config-e2e-p2-"));
		mkdirSync(join(workdir, ".kiso"), { recursive: true });
		writeFileSync(join(workdir, ".kiso", "config.json"), JSON.stringify({ model: "proj-model" }), "utf8");
		const out = stripANSI(
			ptyRun(env, [
				["/ commands · \u2191 history", "/model\r"],
				["define models", "\x1bexit\r"], // esc first — the panel owns printable keys
			], workdir),
		);
		expect(out).not.toContain("trust this project");
		expect(out).toContain("projectTrust: never");
		// MOVED (the picker-surface class, TUI2-R2 4): the zero-profile copy
		// is reproduced VERBATIM in the panel — the user who sees this state
		// is exactly the user who needs the config path spelled out, and a
		// redesign that dropped it to look tidier would have removed the one
		// useful thing the old command did.
		expect(out).toContain("no profiles — define models in ~/.kiso/config.json");
	});
});

describe("merge round B — pipes: trust gate + loud failure", () => {
	it("untrusted project config is never read on the pipe path (regression)", () => {
		// No top-level env keys: if the project config were (wrongly)
		// applied, its model "proj-model" would resolve — instead the
		// session stays faux, proving the config never entered the merge.
		const { env } = isolatedEnv();
		const workdir = mkdtempSync(join(tmpdir(), "kiso-config-e2e-pipe1-"));
		mkdirSync(join(workdir, ".kiso"), { recursive: true });
		writeFileSync(join(workdir, ".kiso", "config.json"), JSON.stringify({ model: "proj-model" }), "utf8");
		const r = runCli(["chat", "pipe"], env, { cwd: workdir, input: "look around\nexit\n" });
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("not trusted, not loaded");
		expect(r.stdout).toContain("[faux mode"); // the project's model was NOT applied
	});

	it("a broken USER config fails the process LOUDLY (file named, non-zero)", () => {
		const { env, dirs } = isolatedEnv();
		writeFileSync(join(dirs.home, "config.json"), "{not json", "utf8");
		const workdir = mkdtempSync(join(tmpdir(), "kiso-config-e2e-pipe2-"));
		const r = runCli(["chat", "broken"], env, { cwd: workdir, input: "exit\n" });
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain("config ~/.kiso/config.json: broken JSON");
	});
});
