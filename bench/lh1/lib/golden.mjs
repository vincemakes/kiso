/** The golden battery, shared by the fixtures whose truth includes
 *  "the CLI still prints exactly this": every case in
 *  <taskDir>/golden/cases.json is run against a workspace's src/cli.mjs
 *  from a scratch directory holding the inputs of <taskDir>/golden/inputs.json
 *  (materialized per run — several are deliberately malformed and could not
 *  be tracked files), and stdout/stderr/exit code are compared byte for byte
 *  with <taskDir>/golden/expected.json. expected.json is written from the SEED
 *  and proven to be the seed's output by the fixture's seed-check.mjs. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

export function runCases(taskDir, ws) {
	const cases = readJson(join(taskDir, "golden", "cases.json"));
	const inputs = readJson(join(taskDir, "golden", "inputs.json"));
	const scratch = mkdtempSync(join(tmpdir(), "lh1-golden-"));
	const out = {};
	try {
		mkdirSync(join(scratch, "inputs"));
		for (const [name, text] of Object.entries(inputs)) {
			mkdirSync(dirname(join(scratch, "inputs", name)), { recursive: true });
			writeFileSync(join(scratch, "inputs", name), text);
		}
		for (const c of cases) {
			// every case runs from the scratch directory; `{ws}` in an argument is
			// the workspace path (for CLIs that take a project-relative data
			// directory) — never let it reach an output, or the golden is not portable
			const args = c.args.map((a) => a.replace(/\{ws\}/g, ws));
			const r = spawnSync(process.execPath, [join(ws, "src", "cli.mjs"), ...args], { cwd: scratch, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
			out[c.id] = { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	return out;
}

/** Ids that differ from expected.json (empty = byte-identical). */
export function compareCases(taskDir, ws) {
	const expected = readJson(join(taskDir, "golden", "expected.json"));
	const actual = runCases(taskDir, ws);
	const bad = Object.keys(actual).filter((id) => {
		const e = expected[id];
		const a = actual[id];
		return !e || e.status !== a.status || e.stdout !== a.stdout || e.stderr !== a.stderr;
	});
	return { bad, total: Object.keys(actual).length };
}

export function writeExpected(taskDir, ws) {
	const out = runCases(taskDir, ws);
	writeFileSync(join(taskDir, "golden", "expected.json"), `${JSON.stringify(out, null, 1)}\n`);
	return Object.keys(out).length;
}
