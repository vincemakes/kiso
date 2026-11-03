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
			// 0.40.0: the sessions stay in the one folder every test names
			// (`<home>/sessions`); the per-project layout's own tests delete it
			KISO_SESSIONS_DIR: join(dirs.home, "sessions"),
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
			// The session title is OFF for every e2e by default, the same way: a
			// leg on a local mock endpoint would send one more request beside
			// its first, and the tests that count requests or read the wire
			// would see it. The title's own test turns it back on.
			KISO_AUTO_TITLE: "off",
			// DC-48: invariant ① THROWS under test. In the field it cuts the
			// row and says so once (compositor #checked) — the crash is the
			// contract UNDER TEST, and a gate that lost its teeth here would
			// be the whole point of the reversal thrown away.
			KISO_INVARIANTS: "throw",
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

/** The transcript with its OSC sequences removed.
 *
 *  `ESC ] … BEL` (and the ST form) addresses the WINDOW — its title, its
 *  icon — never the grid: a terminal consumes it and paints nothing, and
 *  it occupies no cell and no column. A test that reads the raw stream as
 *  though it were screen content must drop them first, or kiso's window
 *  title (0.39.1) reads as a line that was never on screen. Separate from
 *  `stripANSI` because the two are asked for different reasons: that one
 *  removes what DECORATES a line, this one removes what is not a line.
 *  The VT emulator (helpers/vt-screen.ts) consumes them for the tests
 *  that go through it. */
export function stripOsc(text) {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}
