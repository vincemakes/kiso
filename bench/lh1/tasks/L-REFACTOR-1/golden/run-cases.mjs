#!/usr/bin/env node
/** The golden battery: every case's stdout/stderr/exit code against a
 *  workspace's CLI, run from a scratch directory that holds the inputs
 *  (so no path but a relative one is ever echoed). The expected file is
 *  the SEED's own output (seed-check.mjs proves that at selftest time);
 *  the evaluator compares an agent's workspace against it byte for byte.
 *  The inputs live in inputs.json (several are deliberately malformed —
 *  trailing spaces, a missing final newline, a doubled one — which the
 *  repository's whitespace gates would otherwise refuse as tracked files).
 *  usage: run-cases.mjs <workspace> [--write]   (--write regenerates expected.json) */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const cases = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));
export const inputs = JSON.parse(readFileSync(join(here, "inputs.json"), "utf8"));

export function runCases(ws) {
	const scratch = mkdtempSync(join(tmpdir(), "lh1-golden-"));
	mkdirSync(join(scratch, "inputs"));
	for (const [name, text] of Object.entries(inputs)) writeFileSync(join(scratch, "inputs", name), text);
	const out = {};
	try {
		for (const c of cases) {
			const r = spawnSync(process.execPath, [join(ws, "src", "cli.mjs"), ...c.args], { cwd: scratch, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
			out[c.id] = { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	return out;
}

/** Compare a workspace against expected.json; returns the ids that differ. */
export function compareCases(ws) {
	const expected = JSON.parse(readFileSync(join(here, "expected.json"), "utf8"));
	const actual = runCases(ws);
	const bad = [];
	for (const c of cases) {
		const e = expected[c.id];
		const a = actual[c.id];
		if (!e || e.status !== a.status || e.stdout !== a.stdout || e.stderr !== a.stderr) bad.push(c.id);
	}
	return { bad, total: cases.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const ws = process.argv[2];
	if (!ws) {
		console.error("usage: run-cases.mjs <workspace> [--write]");
		process.exit(2);
	}
	if (process.argv.includes("--write")) {
		writeFileSync(join(here, "expected.json"), `${JSON.stringify(runCases(ws), null, 1)}\n`);
		console.log(`[lh1:golden] wrote ${cases.length} cases`);
	} else {
		const { bad, total } = compareCases(ws);
		console.log(`[lh1:golden] ${total - bad.length}/${total} identical${bad.length ? ` — differ: ${bad.join(",")}` : ""}`);
		process.exit(bad.length ? 1 : 0);
	}
}
