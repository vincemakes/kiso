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
