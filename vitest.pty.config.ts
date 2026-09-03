import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";
import manifest from "./tests/pty-suite.json" with { type: "json" };

/** SH-1 — the PTY/process pool: exactly the manifest, one file at a
 *  time (fileParallelism: false) — processes never contend with each
 *  other, and the unit pool has already fully exited. */
export default defineConfig({
	test: {
		...base.test,
		include: manifest.pty,
		fileParallelism: false,
		// …and one macrotask between tests, so a file of synchronous
		// spawnSync cases cannot starve the worker's reply to the runner
		// (tests/setup-pty-yield.ts carries the mechanism). The path is
		// ABSOLUTE for setup-env.ts's reason — a workspace resolves a
		// relative setupFile against its own root (ADR-0043 A11).
		setupFiles: [...(base.test?.setupFiles ?? []), fileURLToPath(new URL("./tests/setup-pty-yield.ts", import.meta.url))],
	},
});
