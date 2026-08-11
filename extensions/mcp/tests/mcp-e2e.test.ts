/**
 * ③ — the MCP bridge e2e: a REAL kiso chat through the CLI's topmost
 * entry, with the BUILT bundle installed as an extension.
 *
 * The bundle + the safe-defaults example go into KISO_EXTENSIONS_DIR; the
 * fake MCP server is configured via KISO_MCP_CONFIG. The faux model calls
 * mcp__fake__echo: safe-defaults ASKS (external tools must pass human
 * review) and — ruling A — the ask goes DIRECTLY to the human pause, so the
 * approval prompt appears; y is injected; the echo result returns to the
 * model; the run completes.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** The async execFile — the PTY drivers run 20s+; a SYNC execFileSync would
 *  block the vitest worker's event loop past the runner's 60s RPC timeout
 *  ("Timeout calling onTaskUpdate") — this file's three 20s runs trip it
 *  deterministically. */
const execFileP = promisify(execFile);
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { SessionStore } from "@vincemakes/kiso-runtime";

const CLI = join(fileURLToPath(new URL("../../../apps/cli", import.meta.url)), "dist", "index.js");
const BUNDLE = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "kiso-mcp.mjs");
const SAFE_DEFAULTS = join(fileURLToPath(new URL("../../../examples", import.meta.url)), "extensions", "safe-defaults.mjs");
const FAKE_SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "fake-server.mjs");

const PTY_DRIVER = `
import pty, os, sys, time, select, fcntl, termios, struct

def driver(cli, home, workdir, ext_dir, mcp_config, script_path, session_id):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["KISO_HOME"] = home
        os.environ["KISO_EXTENSIONS_DIR"] = ext_dir
        os.environ["KISO_MCP_CONFIG"] = mcp_config
        os.environ["KISO_FAUX_SCRIPT"] = script_path
        os.chdir(workdir)
        os.execvp("node", ["node", cli, session_id])
    # R-D 0.1.45: rows=2 keeps the READLINE path (the dock needs >= 4 rows —
    # its panel SGR-splits the title and folds tool results, which this
    # test's byte-linear assertions cannot read); cols=200 fits the FULL
    # extensions banner (83 chars in the longest case — at 80 truncateRow
    # cuts it with a " (+N)" marker, a width behavior render-v2a's job).
    # The child picks the size up on SIGWINCH.
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 2, 200, 0, 0))
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
    # 0.1.26 (lazy connection): the extension returns immediately — the fake server
    # connects in the background. Give the connect a moment to settle before
    # the model's first call (the "first-call waits-for-readiness" wait is the unit tests').
    time.sleep(1.5)
    os.write(fd, b"go\\n")
    read_until(b"approve mcp__fake__echo", 30)
    os.write(fd, b"y\\n")
    read_until(b"the echo worked", 30)
    os.write(fd, b"exit\\n")
    wait_exit(10)
    sys.stdout.write(full.decode(errors="replace"))
    sys.exit(0)
`;

const FAUX_TRAJECTORY = [
	{
		events: [
			{ type: "tool_call_end", callId: "m1", name: "mcp__fake__echo", input: { text: "hello from mcp" } },
			{ type: "stop", reason: "tool_use" },
		],
	},
	{ events: [{ type: "text_delta", text: "the echo worked" }, { type: "stop", reason: "end_turn" }] },
];

describe("③ MCP bridge e2e (through the CLI's topmost entry)", () => {
	it("the bundle loads as an extension; the mcp__ call is ASKED (ruling A), approved, and the result returns to the model", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mcp-e2e-"));
		const home = join(dir, "home");
		const workdir = join(dir, "work");
		const extdir = join(dir, "ext");
		mkdirSync(home, { recursive: true });
		mkdirSync(workdir, { recursive: true });
		mkdirSync(extdir, { recursive: true });
		copyFileSync(BUNDLE, join(extdir, "kiso-mcp.mjs"));
		copyFileSync(SAFE_DEFAULTS, join(extdir, "safe-defaults.mjs"));
		const mcpConfig = join(dir, "mcp.json");
		writeFileSync(
			mcpConfig,
			JSON.stringify({ mcpServers: { fake: { command: "node", args: [FAKE_SERVER] } } }),
			"utf8",
		);
		const scriptPath = join(dir, "faux.json");
		writeFileSync(scriptPath, JSON.stringify(FAUX_TRAJECTORY), "utf8");
		writeFileSync(join(dir, "driver.py"), PTY_DRIVER, "utf8");

		const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(dir, "driver.py"))}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(home)}, ${JSON.stringify(workdir)}, ${JSON.stringify(extdir)}, ${JSON.stringify(mcpConfig)}, ${JSON.stringify(scriptPath)}, "mcp-e2e")
`;
		const { env } = isolatedEnv();
		const out = (await execFileP("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env })).stdout;
		// R-D 0.1.45: the four official extensions are built-in — the user
		// copy SHADOWS the built-in mcp (the cascade in a real CLI), the
		// built-in column lists the rest. 0.1.26: the lazy connect is in
		// flight at the banner ("mcp (connecting…)").
		expect(out).toContain("[5 extensions: built-in: skills, subagent, task · mcp (connecting…), safe-defaults]");
		expect(out).toContain("approve mcp__fake__echo"); // the readline fallback question — the ask tier reached the human
		expect(out).toContain("hello from mcp"); // the echo result returned to the model
		expect(out).toContain("the echo worked");
	}, 180_000);
});

describe("③b MCP bare install (ADR-0042) — no safe-defaults, the external tool STILL meets the human", () => {
	it("only the mcp bundle installed: mcp__ is ASKED under default mode — never silently auto-allowed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mcp-bare-"));
		const home = join(dir, "home");
		const workdir = join(dir, "work");
		const extdir = join(dir, "ext");
		mkdirSync(home, { recursive: true });
		mkdirSync(workdir, { recursive: true });
		mkdirSync(extdir, { recursive: true });
		// The P2 finding's exact profile: the mcp bundle WITHOUT
		// safe-defaults. The mode:default tier abstains on mcp__ (an
		// extension tool) and the bundle has no approvals — an all-abstain
		// chain must fall to the human, never to a silent auto-approve.
		copyFileSync(BUNDLE, join(extdir, "kiso-mcp.mjs"));
		const mcpConfig = join(dir, "mcp.json");
		writeFileSync(
			mcpConfig,
			JSON.stringify({ mcpServers: { fake: { command: "node", args: [FAKE_SERVER] } } }),
			"utf8",
		);
		const scriptPath = join(dir, "faux.json");
		writeFileSync(scriptPath, JSON.stringify(FAUX_TRAJECTORY), "utf8");
		writeFileSync(join(dir, "driver.py"), PTY_DRIVER, "utf8");

		const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(dir, "driver.py"))}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(home)}, ${JSON.stringify(workdir)}, ${JSON.stringify(extdir)}, ${JSON.stringify(mcpConfig)}, ${JSON.stringify(scriptPath)}, "mcp-bare")
`;
		const { env } = isolatedEnv();
		const out = (await execFileP("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env })).stdout;
		expect(out).toContain("[4 extensions: built-in: skills, subagent, task · mcp (connecting…)]"); // R-D 0.1.45: only the user mcp copy loads — the built-in column lists the rest (0.1.26: the banner shows the in-flight connect)
		expect(out).toContain("approve mcp__fake__echo"); // the readline fallback question — the human gate held
		expect(out).toContain("hello from mcp"); // the echo result returned after the approval
		expect(out).toContain("the echo worked");

		// The audit: the approval was HUMAN-decided — no policy's name is
		// on it (a silent-allow would have recorded "mode:default").
		const store = new SessionStore(join(home, "sessions"));
		const decided = store
			.load("mcp-bare")
			.map((r) => r.event)
			.filter((e): e is import("@vincemakes/kiso-core").Event & { type: "permission_decided" } => e.type === "permission_decided");
		expect(decided).toHaveLength(1);
		expect(decided[0]!.decidedBy).toBeUndefined();
		expect(decided[0]!.decision).toBe("approved");
	}, 180_000);
});

const NOISE = "fake-server: running on stdio (ready)";

// The A3 driver: one turn ("go") whose trajectory calls mcp__status — the
// tool's own result carries the captured stderr tail.
const PTY_DRIVER_STATUS = `
import pty, os, sys, time, select, fcntl, termios, struct

def driver(cli, home, workdir, ext_dir, mcp_config, script_path, session_id):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["KISO_HOME"] = home
        os.environ["KISO_EXTENSIONS_DIR"] = ext_dir
        os.environ["KISO_MCP_CONFIG"] = mcp_config
        os.environ["KISO_FAUX_SCRIPT"] = script_path
        os.chdir(workdir)
        os.execvp("node", ["node", cli, session_id])
    # Same rows=2/cols=200 readline-path setup as PTY_DRIVER — the banner
    # content and the UNFOLDED status result must stay byte-linear.
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 2, 200, 0, 0))
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
    # 0.1.26 (lazy connection): the extension returns immediately — the fake server
    # connects in the background. Give the connect a moment to settle before
    # the model's first call (the "first-call waits-for-readiness" wait is the unit tests').
    time.sleep(1.5)
    os.write(fd, b"go\\n")
    # A bare install asks even the extension's OWN status tool (③b) — the
    # ask must be answered or the tool is denied and never executes.
    read_until(b"approve mcp__status", 30)
    os.write(fd, b"y\\n")
    read_until(b"stderr tail:", 30)
    read_until(b"status retrieved", 30)
    os.write(fd, b"exit\\n")
    wait_exit(10)
    sys.stdout.write(full.decode(errors="replace"))
    sys.exit(0)
`;

const FAUX_STATUS_TRAJECTORY = [
	{
		events: [
			{ type: "tool_call_end", callId: "s1", name: "mcp__status", input: {} },
			{ type: "stop", reason: "tool_use" },
		],
	},
	{ events: [{ type: "text_delta", text: "status retrieved" }, { type: "stop", reason: "end_turn" }] },
];

describe("the ergonomics batch A3: the stdio child's stderr is CAPTURED, never leaked", () => {
	it("no \"running on stdio\"-style noise around the startup banner; mcp__status shows the recent tail", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mcp-a3-"));
		const home = join(dir, "home");
		const workdir = join(dir, "work");
		const extdir = join(dir, "ext");
		mkdirSync(home, { recursive: true });
		mkdirSync(workdir, { recursive: true });
		mkdirSync(extdir, { recursive: true });
		copyFileSync(BUNDLE, join(extdir, "kiso-mcp.mjs"));
		const mcpConfig = join(dir, "mcp.json");
		writeFileSync(
			mcpConfig,
			JSON.stringify({ mcpServers: { fake: { command: "node", args: [FAKE_SERVER] } } }),
			"utf8",
		);
		const scriptPath = join(dir, "faux.json");
		writeFileSync(scriptPath, JSON.stringify(FAUX_STATUS_TRAJECTORY), "utf8");
		writeFileSync(join(dir, "driver.py"), PTY_DRIVER_STATUS, "utf8");

		const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(dir, "driver.py"))}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(home)}, ${JSON.stringify(workdir)}, ${JSON.stringify(extdir)}, ${JSON.stringify(mcpConfig)}, ${JSON.stringify(scriptPath)}, "mcp-a3")
`;
		const { env } = isolatedEnv();
		const out = (await execFileP("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env })).stdout;
		const noiseAt = out.indexOf(NOISE);
		// R-D 0.1.45: the banner reads the built-in column + the user column
		// (kiso-mcp.mjs only here) — same shape as the ③b bare install.
		const bannerAt = out.indexOf("[4 extensions: built-in: skills, subagent, task · mcp (connecting…)]");
		expect(bannerAt).toBeGreaterThan(-1); // the startup banner rendered
		// RED on the pre-A3 bundle: the child's stderr inherited the PTY and
		// the noise landed BEFORE the banner (spawn precedes the banner).
		// GREEN: the ring held it — its only appearance is inside the
		// mcp__status result, which renders AFTER the banner.
		expect(noiseAt).toBeGreaterThan(-1);
		expect(noiseAt).toBeGreaterThan(bannerAt);
		expect(out).toContain("stderr tail:"); // the status annotation attached the tail
		expect(out).toContain("status retrieved");
	}, 180_000);
});
