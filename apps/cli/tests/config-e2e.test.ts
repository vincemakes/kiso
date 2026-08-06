/**
 * 合并轮 B — the config surface e2e (BUILT CLI):
 * ① /model on a real PTY with two profiles (one available via the env,
 *   one not) — the listing annotates availability, the switch refuses the
 *   unavailable one loudly and lands the available one's NoticeCell;
 * ② the project .kiso/config.json rides the E3 trust gate — granted →
 *   the project's model appears, projectTrust "never" → no ask, nothing
 *   loads;
 * ③ the pipe path: an untrusted project config is never read (回归), and
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

describe("合并轮 B — /model on a real PTY (dual profiles)", () => {
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
		const out = stripANSI(
			ptyRun(env, [
				["▌ ", "/model\n"],
				["(unavailable)", "/model claude\n"],
				["not set", "/model ds\n"],
				["model → ds", "exit\n"],
			], workdir),
		);
		expect(out).toContain("model: faux");
		expect(out).toContain("ds → openai-compat/deepseek-v4-flash · MY_TEST_KEY (available)");
		expect(out).toContain("claude → anthropic/claude-sonnet-5 · ANTHROPIC_API_KEY (unavailable)");
		expect(out).toContain("model claude: unavailable — the env var ANTHROPIC_API_KEY is not set");
		expect(out).toContain("model → ds (deepseek-v4-flash) — takes effect on the next turn");
	});

	it("a direct provider/model write switches too", () => {
		const { env, dirs } = isolatedEnv();
		env.OPENAI_API_KEY = "sk-fake";
		const workdir = mkdtempSync(join(tmpdir(), "kiso-config-e2e-w2-"));
		const out = stripANSI(
			ptyRun(env, [
				["▌ ", "/model openai-compat/gpt-4o\n"],
				["model → openai-compat/gpt-4o", "exit\n"],
			], workdir),
		);
		expect(out).toContain("model → openai-compat/gpt-4o (gpt-4o) — takes effect on the next turn");
	});
});

describe("合并轮 B — the project config rides the E3 trust gate", () => {
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
				["trust this project", "y\n"],
				["▌ ", "/model\n"],
				["proj-model", "exit\n"],
			], workdir),
		);
		expect(out).toContain("trust this project's .kiso? (y/n)");
		expect(out).toContain("model: proj-model-x"); // the project's model drives the session
		expect(out).toContain("proj-model → openai-compat/proj-model-x · MY_TEST_KEY (available)");
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
				["▌ ", "/model\n"],
				["(none — define models", "exit\n"],
			], workdir),
		);
		expect(out).not.toContain("trust this project");
		expect(out).toContain("projectTrust: never");
		expect(out).toContain("(none — define models in ~/.kiso/config.json)");
	});
});

describe("合并轮 B — pipes: trust gate + loud failure", () => {
	it("untrusted project config is never read on the pipe path (回归)", () => {
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
