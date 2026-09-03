/**
 * The per-run TMPDIR root reaches a CHILD process (tests/global-tmpdir.ts).
 *
 * The isolation helper, the PTY driver and the built CLI are all spawned
 * with `...process.env`, so whatever a child writes for itself (the
 * skills merge directory, the mcp merge file) lands inside the root too.
 * Two runtimes are asserted: node (the CLI) and python3 (the PTY
 * driver's interpreter, whose tempfile module reads TMPDIR the same way).
 * Process-spawning, hence the pty pool (SH-1).
 */

import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename } from "node:path";
import { describe, expect, test } from "vitest";
import { ROOT_PREFIX } from "./global-tmpdir.js";

describe("the per-run TMPDIR root (pty pool)", () => {
	test("a node child spawned with process.env sees the same root", () => {
		const root = tmpdir();
		expect(basename(root).startsWith(ROOT_PREFIX)).toBe(true);
		const child = spawnSync(process.execPath, ["-e", "process.stdout.write(require('node:os').tmpdir())"], { encoding: "utf8", env: { ...process.env } });
		expect(child.status).toBe(0);
		expect(child.stdout).toBe(root);
	});

	test("a python3 child (the PTY driver's runtime) sees the same root", () => {
		const root = tmpdir();
		const child = spawnSync("python3", ["-c", "import tempfile, sys; sys.stdout.write(tempfile.gettempdir())"], { encoding: "utf8", env: { ...process.env } });
		expect(child.status).toBe(0);
		expect(child.stdout).toBe(root);
	});
});
