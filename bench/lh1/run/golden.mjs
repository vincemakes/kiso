#!/usr/bin/env node
/** Run a fixture's golden battery against a workspace.
 *  usage: golden.mjs <taskName> <workspace> [--write]   (--write regenerates expected.json from that workspace — only ever from a pristine seed) */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compareCases, writeExpected } from "../lib/golden.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const [task, ws] = process.argv.slice(2);
if (!task || !ws) {
	console.error("usage: golden.mjs <taskName> <workspace> [--write]");
	process.exit(2);
}
const taskDir = join(here, "..", "tasks", task);
if (process.argv.includes("--write")) {
	console.log(`[lh1:golden] ${task}: wrote ${writeExpected(taskDir, ws)} cases`);
} else {
	const { bad, total } = compareCases(taskDir, ws);
	console.log(`[lh1:golden] ${task}: ${total - bad.length}/${total} identical${bad.length ? ` — differ: ${bad.join(",")}` : ""}`);
	process.exit(bad.length ? 1 : 0);
}
