/**
 * The per-run TMPDIR root is live in the UNIT pool (tests/global-tmpdir.ts).
 *
 * Red without the globalSetup wiring in vitest.config.ts: os.tmpdir() is
 * then the host's real temp directory and the prefix assertion fails.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { ROOT_PREFIX } from "./global-tmpdir.js";

describe("the per-run TMPDIR root (unit pool)", () => {
	test("os.tmpdir() is this run's own root, and mkdtemp lands inside it", () => {
		const root = tmpdir();
		expect(basename(root).startsWith(ROOT_PREFIX)).toBe(true);
		expect(process.env.TMPDIR).toBe(root);
		const d = mkdtempSync(join(tmpdir(), "kiso-tmpdir-probe-"));
		expect(dirname(d)).toBe(root);
		expect(existsSync(d)).toBe(true);
	});
});
