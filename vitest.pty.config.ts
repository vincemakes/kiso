import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";
import manifest from "./tests/pty-suite.json" with { type: "json" };

/** SH-1 — the PTY/process pool: exactly the manifest, one file at a
 *  time (fileParallelism: false) — processes never contend with each
 *  other, and the unit pool has already fully exited.
 *
 *  TT-1 coda: `pool: "forks"` — the worker-THREADS pool's birpc starved
 *  under this suite's subprocess I/O and threw "[vitest-worker]:
 *  Timeout calling onTaskUpdate" with every test green (2/2 full-check
 *  runs; never in a standalone pty run). A process-heavy suite gets
 *  process isolation: child-process IPC instead of a MessagePort
 *  sharing the thread with PTY churn. */
export default defineConfig({
	test: {
		...base.test,
		include: manifest.pty,
		fileParallelism: false,
		pool: "forks",
	},
});
