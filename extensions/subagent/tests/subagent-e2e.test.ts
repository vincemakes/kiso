/**
 * ④ — subagent e2e: a REAL kiso chat through the CLI's topmost entry with
 * the BUILT bundle installed, plus the depth-guard e2e in a real child.
 *
 * The parent (faux) calls delegate with one explorer task; safe-defaults
 * ASKS (裁决 A: the prompt appears), y is injected, the child runs under
 * its read-only role policy, and the result section — extracted from the
 * child's OWN session JSONL — returns to the model. The child session is
 * durable (the selling point): it exists on disk with a terminal.
 */

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("../../../apps/cli", import.meta.url)), "dist", "index.js");
const BUNDLE = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "kiso-subagent.mjs");
const SAFE_DEFAULTS = join(fileURLToPath(new URL("../../../examples", import.meta.url)), "extensions", "safe-defaults.mjs");

/** Child runs are faux: no API keys may leak into the spawned children. */
function fauxEnv(): void {
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.OPENAI_API_KEY;
}

const PTY_DRIVER = `
import pty, os, sys, time, select

def driver(cli, home, workdir, ext_dir, script_path, session_id):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["KISO_HOME"] = home
        os.environ["KISO_EXTENSIONS_DIR"] = ext_dir
        os.environ["KISO_FAUX_SCRIPT"] = script_path
        os.chdir(workdir)
        os.execvp("node", ["node", cli, session_id])
    out = b""
    full = b""
    def read_until(needle, timeout):
        nonlocal out, full
        end = time.time() + timeout
        while time.time() < end:
            idx = out.find(needle)
            if idx >= 0:
                out = out[idx + len(needle):]
                return True
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    data = os.read(fd, 4096)
                    out += data
                    full += data
                except OSError:
                    return False
        return False
    def wait_exit(timeout):
        nonlocal out, full
        end = time.time() + timeout
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    data = os.read(fd, 4096)
                    if not data:
                        return
                    out += data
                    full += data
                except OSError:
                    return
    read_until(b"you> ", 20)
    os.write(fd, b"go\\n")
    read_until(b"approve delegate", 30)
    os.write(fd, b"y\\n")
    read_until(b"done", 40)
    os.write(fd, b"exit\\n")
    wait_exit(10)
    sys.stdout.write(full.decode(errors="replace"))
    sys.exit(0)
`;

const FAUX_TRAJECTORY = [
	{
		events: [
			{
				type: "tool_call_end",
				callId: "d1",
				name: "delegate",
				input: { tasks: [{ role: "explorer", task: "explore the workspace" }] },
			},
			{ type: "stop", reason: "tool_use" },
		],
	},
	{ events: [{ type: "text_delta", text: "parent done" }, { type: "stop", reason: "end_turn" }] },
];

describe("④ subagent e2e (through the CLI's topmost entry)", () => {
	it("delegate is ASKED (裁决 A), approved, the child runs, its JSONL-sourced result returns, and the child session is durable", async () => {
		fauxEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-subagent-e2e-"));
		const home = join(dir, "home");
		const workdir = join(dir, "work");
		const extdir = join(dir, "ext");
		mkdirSync(home, { recursive: true });
		mkdirSync(workdir, { recursive: true });
		mkdirSync(extdir, { recursive: true });
		copyFileSync(BUNDLE, join(extdir, "subagent.mjs"));
		copyFileSync(SAFE_DEFAULTS, join(extdir, "safe-defaults.mjs"));
		const scriptPath = join(dir, "faux.json");
		writeFileSync(scriptPath, JSON.stringify(FAUX_TRAJECTORY), "utf8");
		writeFileSync(join(dir, "driver.py"), PTY_DRIVER, "utf8");

		const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(dir, "driver.py"))}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(home)}, ${JSON.stringify(workdir)}, ${JSON.stringify(extdir)}, ${JSON.stringify(scriptPath)}, "sub-e2e")
`;
		const { env } = isolatedEnv();
		const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env });
		expect(out).toContain("[2 extensions: safe-defaults, subagent]"); // sorted by file name
		expect(out).toContain("approve delegate"); // the ask tier reached the human (裁决 A)
		expect(out).toContain("outcome: completed"); // the child's result section returned to the model
		expect(out).toContain("done");
		// The durable-child selling point: the child's own session exists
		// with a terminal, right in the normal sessions directory.
		const sessions = join(home, "sessions");
		const childFile = readdirSync(sessions).find((f) => f.endsWith("-1-explorer.jsonl"));
		expect(childFile).toBeDefined();
		expect(readFileSync(join(sessions, childFile!), "utf8")).toContain('"terminal"');
	}, 180_000);

	it("depth e2e: a child's own attempt to call delegate fails — the tool does not exist (guard effective in the child)", async () => {
		fauxEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-subagent-depth-"));
		const home = join(dir, "home");
		const extdir = join(dir, "ext");
		mkdirSync(home, { recursive: true });
		mkdirSync(extdir, { recursive: true });
		copyFileSync(BUNDLE, join(extdir, "subagent.mjs"));
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{ events: [{ type: "tool_call_end", callId: "d1", name: "delegate", input: { tasks: [{ role: "explorer", task: "nested" }] } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const child = spawn(process.execPath, [CLI, "chat", "sub-depth"], {
			env: {
				...isolatedEnv().env, // P2: the full isolation set — the host ~/.kiso never leaks
				KISO_HOME: home,
				KISO_SUBAGENT_DEPTH: "1",
				KISO_EXTENSIONS_DIR: extdir,
				KISO_FAUX_SCRIPT: script,
			},
			stdio: ["pipe", "pipe", "inherit"],
		});
		child.stdin.write("go\nexit\n");
		child.stdin.end();
		await new Promise<void>((resolve) => child.on("exit", () => resolve()));
		const events = readFileSync(join(home, "sessions", "sub-depth.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l))
			.map((r) => r.event ?? r);
		expect(events.some((e) => e.type === "tool_result" && String(e.content).includes("Unknown tool: delegate"))).toBe(true);
		expect(events.some((e) => e.type === "terminal")).toBe(true);
	}, 60_000);
});
