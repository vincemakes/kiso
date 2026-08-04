/**
 * 发现#8 (P1) — the MCP dispose lifecycle e2e: a REAL kiso process with a
 * configured MCP server must exit PROMPTLY and leave NO orphan children
 * (the stdio transport's reader would otherwise hold the host's event loop
 * alive forever), and a server that never answers the handshake must be a
 * bounded SOFT failure — the 15s connect timeout (发现#8b) — visible in
 * mcp__status while the other servers keep working.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = join(fileURLToPath(new URL("../../../apps/cli", import.meta.url)), "dist", "index.js");
const BUNDLE = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "kiso-mcp.mjs");
const SAFE_DEFAULTS = join(fileURLToPath(new URL("../../../examples", import.meta.url)), "extensions", "safe-defaults.mjs");
const FAKE_SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "fake-server.mjs");

function fauxEnv(): void {
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.OPENAI_API_KEY;
}

const DISPOSE_DRIVER = `
import pty, os, sys, time, select

def driver(cli, home, ext_dir, mcp_config):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["KISO_HOME"] = home
        os.environ["KISO_EXTENSIONS_DIR"] = ext_dir
        os.environ["KISO_MCP_CONFIG"] = mcp_config
        os.execvp("node", ["node", cli, "chat", "dispose-t"])
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
                        return True
                    out += data
                    full += data
                except OSError:
                    return True
        return False
    if not read_until(b"you> ", 15):
        sys.exit(2)
    os.write(fd, b"exit\\n")
    # The hard clause: dispose must let the process exit within 5s of the
    # exit command (without dispose the transport reader holds it forever).
    exited = wait_exit(5)
    if not exited:
        try:
            os.kill(pid, 9)
        except OSError:
            pass
        sys.exit(3)
    sys.stdout.write(full.decode(errors="replace"))
    sys.exit(0)
`;

describe("发现#8: MCP dispose + connect timeout", () => {
	it("the CLI exits within 5s of the exit command and leaves NO orphan MCP children", () => {
		fauxEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-mcp-dispose-"));
		const home = join(dir, "home");
		const extdir = join(dir, "ext");
		mkdirSync(home, { recursive: true });
		mkdirSync(extdir, { recursive: true });
		copyFileSync(BUNDLE, join(extdir, "kiso-mcp.mjs"));
		const mcpConfig = join(dir, "mcp.json");
		writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { fake: { command: "node", args: [FAKE_SERVER] } } }), "utf8");
		writeFileSync(join(dir, "driver.py"), DISPOSE_DRIVER, "utf8");
		const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(dir, "driver.py"))}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(home)}, ${JSON.stringify(extdir)}, ${JSON.stringify(mcpConfig)})
`;
		// exit 3 = the process did NOT exit within 5s — the test fails.
		execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 60_000 });
		// No orphaned fake-server children by command-line feature.
		expect(() => execFileSync("pgrep", ["-f", "fake-server.mjs"], { stdio: "ignore" })).toThrow();
	}, 90_000);

	it("发现#8b: a server that never answers the handshake is a bounded SOFT failure — mcp__status shows the timeout, the other server works", () => {
		fauxEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-mcp-timeout-"));
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
			JSON.stringify({
				mcpServers: {
					sleepy: { command: "sleep", args: ["60"] }, // never answers initialize
					fake: { command: "node", args: [FAKE_SERVER] },
				},
			}),
			"utf8",
		);
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{ events: [{ type: "tool_call_end", callId: "s1", name: "mcp__status", input: {} }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "text_delta", text: "done" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const driver = join(dir, "driver.py");
		writeFileSync(
			driver,
			`
import pty, os, sys, time, select

def driver(cli, home, workdir, ext_dir, mcp_config, script_path):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["KISO_HOME"] = home
        os.environ["KISO_EXTENSIONS_DIR"] = ext_dir
        os.environ["KISO_MCP_CONFIG"] = mcp_config
        os.environ["KISO_FAUX_SCRIPT"] = script_path
        os.chdir(workdir)
        os.execvp("node", ["node", cli, "chat", "timeout-t"])
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
    t0 = time.time()
    ok = read_until(b"you> ", 30)   # the startup completed — bounded by the 15s connect timeout
    elapsed = time.time() - t0
    if ok:
        os.write(fd, b"go\\n")
        read_until(b"approve mcp__status", 15)
        os.write(fd, b"y\\n")
        read_until(b"done", 15)
        os.write(fd, b"exit\\n")
    wait_exit(10)
    sys.stdout.write(full.decode(errors="replace"))
    print("ELAPSED=%.1f" % elapsed, file=sys.stderr)
    sys.exit(0 if ok else 1)
`,
			"utf8",
		);
		const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driver)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(home)}, ${JSON.stringify(workdir)}, ${JSON.stringify(extdir)}, ${JSON.stringify(mcpConfig)}, ${JSON.stringify(script)})
`;
		const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000 });
		expect(out).toContain("sleepy: error"); // the timeout is a SOFT failure
		expect(out).toContain("timed out after 15000ms");
		expect(out).toContain("fake: connected"); // the other server works
		expect(out).toContain("done");
	}, 120_000);
});
