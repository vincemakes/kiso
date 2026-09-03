/**
 * P2 (test hygiene) — the shared CLI-e2e isolation helper.
 *
 * EVERY CLI e2e must run against a FULLY isolated environment: the host's
 * ~/.kiso state (installed extensions, mcp.json, skills) must never leak
 * into a test — the real ~/.kiso once held an MCP install that made the
 * kill9 gate's CLI un-killable mid-connect. `isolatedEnv` builds the four
 * isolation directories (home/extensions/mcp.json/skills) and the env that
 * injects them; `runCli` runs the BUILT CLI with that env. Real-process
 * e2e measure correctness, never speed — their timeouts are generous.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(fileURLToPath(new URL("../../apps/cli", import.meta.url)), "dist", "index.js");

/** A fresh, fully isolated environment for one CLI e2e. `extra` may add or
 *  override (KISO_FAUX_SCRIPT, KISO_CONTEXT_WINDOW, ...). */
export function isolatedEnv(extra = {}) {
	const root = mkdtempSync(join(tmpdir(), "kiso-e2e-"));
	const dirs = {
		home: join(root, "home"),
		extensions: join(root, "extensions"),
		skills: join(root, "skills"),
		mcpConfig: join(root, "mcp.json"),
	};
	mkdirSync(dirs.home, { recursive: true });
	mkdirSync(dirs.extensions, { recursive: true });
	mkdirSync(dirs.skills, { recursive: true });
	return {
		dirs,
		env: {
			...process.env,
			KISO_HOME: dirs.home,
			KISO_EXTENSIONS_DIR: dirs.extensions,
			KISO_MCP_CONFIG: dirs.mcpConfig,
			KISO_SKILLS_DIR: dirs.skills,
			// The update check is OFF for every e2e by default. A leg that
			// carries a real model config would otherwise reach the public
			// registry from the test suite, and a suite that touches the
			// network is a suite that fails for reasons that are not the
			// product's. The one test that exercises the check turns it
			// back on and points it at a local stub.
			KISO_NO_UPDATE_CHECK: "1",
			...extra,
		},
	};
}

/** Run the built CLI with the given env — the timeout is explicit and
 *  generous (≥30s): these tests measure correctness, not speed. E3: the
 *  project-trust e2e needs a working directory with .kiso artifacts, so
 *  options.cwd passes the CLI's process.cwd. */
export function runCli(args, env, options = {}) {
	return spawnSync("node", [CLI, ...args], {
		input: options.input ?? "",
		encoding: "utf8",
		env,
		cwd: options.cwd,
		timeout: options.timeout ?? 30_000,
	});
}

/** v2b: strip ANSI CSI sequences and CR from a PTY transcript — the dock's
 *  cursor moves and the pty's \r\n cooking sit between content chunks, so
 *  content assertions run on the stripped stream. */
export function stripANSI(text) {
	return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
}
