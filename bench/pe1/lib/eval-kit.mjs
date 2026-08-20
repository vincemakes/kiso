/**
 * PE-1 eval kit — the small shared vocabulary of the external evaluators.
 *
 * The three-layer law: an evaluator here NEVER reads a kiso verdict,
 * a session log, or an agent transcript. It sees the workspace the way
 * the outside world would: files, a git history, process behavior.
 * (Evidence system cannot certify itself — ADR queue, PE-1 spec v2.)
 */

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Run `npm test` in the workspace. Returns { ok, output }. */
export function runTests(ws) {
	try {
		const output = execFileSync("npm", ["test", "--silent"], {
			cwd: ws,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 120_000,
		});
		return { ok: true, output };
	} catch (err) {
		const out = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
		return { ok: false, output: out };
	}
}

/** Copy every hidden test into the workspace's tests/, then run the
 *  suite. Call AFTER any git-invariant checks — injection dirties the
 *  tree by design. */
export function runWithHidden(ws, taskDir) {
	const hiddenDir = join(taskDir, "hidden");
	if (existsSync(hiddenDir)) {
		for (const f of readdirSync(hiddenDir)) {
			cpSync(join(hiddenDir, f), join(ws, "tests", f));
		}
	}
	return runTests(ws);
}

/** Paths (committed OR worktree) changed since the seed tag, optionally
 *  scoped. The agent does not commit — diff against the tag sees both. */
export function changedSinceSeed(ws, scope) {
	const args = ["diff", "--name-only", "seed"];
	if (scope !== undefined) args.push("--", scope);
	const out = execFileSync("git", args, { cwd: ws, encoding: "utf8" });
	return out.split("\n").filter(Boolean);
}

/** Run a node script inside the workspace; returns {stdout, stderr, code}.
 *  spawnSync, not execFileSync: stderr must be observable on the SUCCESS
 *  path too (the t3 selftest caught exec's stdout-only return). */
export function probe(ws, scriptArgs, opts = {}) {
	const r = spawnSync(process.execPath, scriptArgs, {
		cwd: ws,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30_000,
		...opts,
	});
	return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

/** Case-insensitive needle search across every file under a dir. */
export function grepTree(ws, subdir, needle) {
	const hits = [];
	const walk = (d) => {
		for (const e of readdirSync(join(ws, d), { withFileTypes: true })) {
			const rel = join(d, e.name);
			if (e.isDirectory()) walk(rel);
			else if (readFileSync(join(ws, rel), "utf8").toLowerCase().includes(needle.toLowerCase())) hits.push(rel);
		}
	};
	walk(subdir);
	return hits;
}

/** The verdict printer: every check named, then exit. */
export function verdict(taskName, checks) {
	let pass = true;
	for (const [name, ok, detail] of checks) {
		if (!ok) pass = false;
		console.log(`[pe1:${taskName}] ${ok ? "ok " : "RED"} — ${name}${!ok && detail ? ` (${String(detail).slice(0, 200)})` : ""}`);
	}
	console.log(`[pe1:${taskName}] ${pass ? "PASS" : "FAIL"}`);
	process.exit(pass ? 0 : 1);
}
