import { defineConfig } from "vitest/config";

/**
 * Root vitest config. The bench harness's fixture projects
 * (bench/fixture-*) are SYNTHETIC broken repos whose tests intentionally
 * fail — the benchmark agents' job is to fix them. They are fixtures, not
 * product tests: excluded here, alongside vitest's defaults.
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
		],
	},
});
