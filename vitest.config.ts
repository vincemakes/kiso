import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Root vitest config. The bench harness's fixture projects
 * (bench/fixture-*) are SYNTHETIC broken repos whose tests intentionally
 * fail — the benchmark agents' job is to fix them. They are fixtures, not
 * product tests: excluded here, alongside vitest's defaults.
 *
 * KC3 slice 0 (the KC2-B3 hardening): `.claude/` is excluded too. An
 * agent worktree lives at .claude/worktrees/<id> — a FULL second copy of
 * this repo, tests included. A worktree that outlives its round (the
 * integrator's removal is a manual step, and KC2-B3 is the round where
 * one did) makes the root run collect every suite TWICE: the file count
 * doubles, the same names appear from two roots, and a stale copy's
 * failures are reported against the live tree. The exclusion makes that
 * hazard structural rather than procedural — the collection is the
 * tracked tree's, whatever is parked under .claude/.
 */
export default defineConfig({
	test: {
		// PH-1a (finding PH-F5, the isolation half): a host shell exporting
		// NO_COLOR turned ~30 palette-asserting UI tests red — the suite's
		// verdict depended on the invoking shell's profile. The setup file
		// strips it once per worker; tests that TEST NO_COLOR set it
		// themselves inside the test body and are unaffected.
		// Absolute on purpose: a workspace-scoped run (`npm test --workspace
		// packages/core`) finds this config by walking up but resolves
		// relative setup paths against ITS cwd — the file "did not exist"
		// at packages/core/tests/setup-env.ts (ADR-0043 Amendment 11's
		// hygiene item).
		setupFiles: [fileURLToPath(new URL("./tests/setup-env.ts", import.meta.url))],
		// The per-run TMPDIR root (tests/global-tmpdir.ts, the 2026-09-03
		// TMPDIR finding): one directory per vitest invocation under the real
		// tmpdir, every worker's and every child's os.tmpdir() inside it,
		// removed at teardown. Both pools spread this config, so both
		// inherit it. Absolute for setupFiles' reason.
		globalSetup: [fileURLToPath(new URL("./tests/global-tmpdir.ts", import.meta.url))],
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/cypress/**",
			"**/.{idea,git,cache,output,temp}/**",
			"**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
			"bench/**",
			"**/.claude/**",
		],
	},
});
