#!/usr/bin/env node
/**
 * Area 7 acceptance: `npm run demo` must START (faux mode) and EXIT
 * cleanly on the exit command. Piped stdin exercises the full REPL path.
 */

import { spawnSync } from "node:child_process";

const result = spawnSync("npm", ["run", "demo"], {
	input: "exit\n",
	encoding: "utf8",
	timeout: 30_000,
});
if (result.status !== 0) {
	console.error(result.stdout);
	console.error(result.stderr);
	console.error("[demo] did not exit cleanly");
	process.exit(1);
}
if (!/faux mode/.test(result.stdout)) {
	console.error(`[demo] did not start in faux mode:\n${result.stdout}`);
	process.exit(1);
}
console.log("[demo] starts and exits cleanly");
