/** LH-1's evaluator kit: PE-1's, plus the invariants the protocol adds. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
export { runTests, runWithHidden, changedSinceSeed, probe, grepTree } from "../../pe1/lib/eval-kit.mjs";
import { changedSinceSeed } from "../../pe1/lib/eval-kit.mjs";

/** `**` crosses directories, `*` one segment; everything else literal. */
export function globToRegExp(glob) {
	let re = "^";
	for (let i = 0; i < glob.length; i += 1) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i += 1;
				if (glob[i + 1] === "/") i += 1;
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`${re}$`);
}

/** The allowed-paths invariant: every path changed since seed matches one glob.
 *  Returns the offenders (empty = ok). */
export function outsideAllowed(ws, allowed) {
	const res = allowed.map(globToRegExp);
	return changedSinceSeed(ws).filter((p) => !res.some((r) => r.test(p)));
}

/** A file's bytes are unchanged since seed (the no-destruction invariant). */
export function unchangedSinceSeed(ws, path) {
	return !changedSinceSeed(ws, path).includes(path);
}

/** A stable hash of the working tree's tracked+untracked content (for replay equality). */
export function treeHash(ws) {
	execFileSync("git", ["add", "-N", "."], { cwd: ws, stdio: "ignore" });
	const diff = execFileSync("git", ["diff", "seed"], { cwd: ws, maxBuffer: 256 * 1024 * 1024 });
	return createHash("sha256").update(diff).digest("hex");
}

/** The verdict: prints one line per check (with a detail for humans) and
 *  exits 0/1. The `[lh1:verdict-json]` line is the leg's RECORD and carries
 *  only what is scored — name and ok per check — so that a rescore from
 *  the archive is byte-comparable: a detail (a test runner's output, a
 *  path under a temp directory, a duration) is diagnostic, not scored,
 *  and would make two evaluations of the same tree differ. */
export function verdict(taskName, checks) {
	let pass = true;
	const rows = [];
	for (const [name, ok, detail] of checks) {
		if (!ok) pass = false;
		rows.push({ name, ok });
		console.log(`[lh1:${taskName}] ${ok ? "ok " : "RED"} — ${name}${!ok && detail ? ` (${String(detail).slice(0, 400).replace(/\n/g, " ⏎ ")})` : ""}`);
	}
	console.log(`[lh1:${taskName}] ${pass ? "PASS" : "FAIL"}`);
	console.log(`[lh1:verdict-json] ${JSON.stringify({ task: taskName, pass, checks: rows })}`);
	process.exit(pass ? 0 : 1);
}
export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
