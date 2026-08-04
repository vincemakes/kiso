/**
 * ③ — the MCP bridge e2e: a REAL kiso chat through the CLI's topmost
 * entry, with the BUILT bundle installed as an extension.
 *
 * The bundle + the safe-defaults example go into KISO_EXTENSIONS_DIR; the
 * fake MCP server is configured via KISO_MCP_CONFIG. The faux model calls
 * mcp__fake__echo: safe-defaults ASKS (external tools must pass human
 * review) and — 裁决 A — the ask goes DIRECTLY to the human pause, so the
 * approval prompt appears; y is injected; the echo result returns to the
 * model; the run completes.
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

const PTY_DRIVER = `
import pty, os, sys, time, select

def driver(cli, home, workdir, ext_dir, mcp_config, script_path, session_id):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["KISO_HOME"] = home
        os.environ["KISO_EXTENSIONS_DIR"] = ext_dir
        os.environ["KISO_MCP_CONFIG"] = mcp_config
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
    read_until(b"approve mcp__fake__echo", 30)
    os.write(fd, b"y\\n")
    read_until(b"done", 30)
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
	it("the bundle loads as an extension; the mcp__ call is ASKED (裁决 A), approved, and the result returns to the model", async () => {
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
		const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000 });
		expect(out).toContain("[2 extensions: mcp, safe-defaults]"); // the banner names the bundle
		expect(out).toContain("approve mcp__fake__echo"); // 审批提问出现 — the ask tier reached the human
		expect(out).toContain("hello from mcp"); // the echo result returned to the model
		expect(out).toContain("done"); // the run completed
	}, 180_000);
});
