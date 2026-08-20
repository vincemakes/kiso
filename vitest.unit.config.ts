import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";
import manifest from "./tests/pty-suite.json" with { type: "json" };

/** SH-1 — the UNIT pool: everything NOT in tests/pty-suite.json, fully
 *  parallel. The pty pool runs AFTER this invocation exits (the `&&` in
 *  package.json is the ordering — explicit, dumb, unmistakable). */
export default defineConfig({
	test: {
		...base.test,
		exclude: [...(base.test?.exclude ?? []), ...manifest.pty],
	},
});
