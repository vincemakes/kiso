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
	},
});
