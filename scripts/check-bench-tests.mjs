#!/usr/bin/env node
/**
 * The bench extractors' own tests actually run.
 *
 * bench/tests/ holds five unittest files pinning the accounting the
 * README tables and every paired verdict are computed from. Each one
 * documented its command as
 *
 *   python3 -m unittest tests/test_extract.py   (from bench/)
 *
 * and that command has never worked: bench/tests/ has no __init__.py, so
 * unittest cannot import it as a package and answers
 * `ModuleNotFoundError: No module named 'tests.test_extract'` — a line
 * that reads like a missing test rather than a broken invocation. So the
 * files were green by assumption and nothing in `npm run check` ran them.
 *
 * They are run here, directly (`python3 tests/test_X.py`), which works.
 * The gate fails if any file fails, and it fails LOUDLY if a file
 * disappears or stops containing tests — a discovery gate that finds
 * nothing must never exit 0 (bench/check-bench-repro.mjs exists for the
 * same reason: a tool that reports 0/0 and exits 0 looks exactly like a
 * tool that worked).
 *
 * Placed AFTER `npm run build` in the chain: test_trace_report.py drives
 * bench/trace-report.mjs, which imports packages/runtime/dist.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BENCH = join(ROOT, "bench");
const TESTS = join(BENCH, "tests");

const files = readdirSync(TESTS).filter((f) => f.startsWith("test_") && f.endsWith(".py")).sort();

/** A discovery gate that discovers nothing is a gate that is not running. */
if (files.length === 0) {
	console.error("check-bench-tests: no test_*.py under bench/tests — the gate found nothing to run");
	process.exit(1);
}

let failed = 0;
let total = 0;
for (const f of files) {
	try {
		execFileSync("python3", [join("tests", f)], {
			cwd: BENCH,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 120_000,
		});
	} catch (err) {
		const text = `${err.stdout ?? ""}${err.stderr ?? ""}`;
		console.error(`FAIL  bench/tests/${f}`);
		console.error(text.trimEnd());
		failed += 1;
		continue;
	}
	// The count is derived from the file, not from unittest's summary: the
	// summary goes to stderr and is discarded on the success path, and a
	// count nobody computed is exactly the failure this repo keeps making.
	const ran = countTests(join(TESTS, f));
	total += ran;
	console.log(`ok    bench/tests/${f}  (${ran} tests)`);
}

if (failed > 0) {
	console.error(`check-bench-tests: ${failed} of ${files.length} files failed`);
	process.exit(1);
}
console.log(`check-bench-tests: ${files.length} files, ${total} tests, all green`);

/** Count `def test_*` in a file — asserted > 0 so an emptied file fails. */
function countTests(path) {
	const src = readFileSync(path, "utf8");
	const n = (src.match(/^\s*def test_/gm) ?? []).length;
	if (n === 0) {
		console.error(`check-bench-tests: ${path} contains no test functions`);
		process.exit(1);
	}
	return n;
}
