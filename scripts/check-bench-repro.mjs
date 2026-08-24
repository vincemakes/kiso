#!/usr/bin/env node
/**
 * The fresh-clone reproduction gate.
 *
 * RD-1B's report promised that four commands re-derive every number in
 * it from the archived artifacts. They did not: all three tools read the
 * UNTRACKED working directory (bench/rd1/out/), so they worked on the
 * author's machine and nowhere else. A reviewer running `git archive
 * HEAD` got DRIFTED, a silent empty `0/0` grid, and a FileNotFoundError
 * — and the silent one is the reason this gate exists at all. A tool
 * that reports 0/0 and exits 0 looks exactly like a tool that worked.
 *
 * So the claim is now mechanical: copy the TRACKED files into an empty
 * directory and run the documented commands there. Untracked paths —
 * bench/rd1/out/ above all — are out of scope by construction, which is
 * exactly the property being gated. Tracked files are taken from the
 * WORKING TREE rather than HEAD so the gate fails before a commit
 * rather than after one; what a fresh clone sees is the same set.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const BATCHES = ["rd1b-kiso", "rd1b-pi"];
const CLEAN = ["rd1b-clean-kiso", "rd1b-clean-pi"];
const errs = [];

const dir = mkdtempSync(join(tmpdir(), "kiso-bench-repro-"));
try {
	// The tracked tree, and only the tracked tree.
	execFileSync("sh", ["-c", `git ls-files -z | tar --null -T - -cf - | tar -xf - -C ${JSON.stringify(dir)}`], { cwd: ROOT });

	const run = (script, args) => {
		try {
			return { out: execFileSync("python3", [join(dir, "bench/rd1/harness", script), ...args], { cwd: dir, encoding: "utf8", timeout: 300_000 }), code: 0 };
		} catch (e) {
			return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
		}
	};

	const verify = run("archive.py", ["--verify", ...BATCHES]);
	if (verify.code !== 0) errs.push(`archive.py --verify exited ${verify.code} in a fresh clone:\n${verify.out.trim().split("\n").slice(-3).join("\n")}`);
	else if (!/INTACT/.test(verify.out)) errs.push(`archive.py --verify did not report INTACT:\n${verify.out.trim()}`);

	const rescore = run("rescore.py", BATCHES);
	if (rescore.code !== 0) errs.push(`rescore.py exited ${rescore.code} in a fresh clone:\n${rescore.out.trim().split("\n").slice(-3).join("\n")}`);
	else {
		// The failure that motivated this gate: an EMPTY grid, exit 0.
		for (const b of BATCHES) {
			const m = new RegExp(`${b}[^\\n]*?(\\d+) cells`).exec(rescore.out);
			if (!m) errs.push(`rescore.py printed no cell count for ${b}`);
			else if (Number(m[1]) !== 20) errs.push(`rescore.py saw ${m[1]} cells for ${b}, expected 20 — a fresh clone must see the whole batch`);
		}
		// SCENARIOS.md's deliverable is the five-axis grid, not a verdict.
		for (const axis of ["duplicate_effect", "silent_retry", "lost_work", "fabricated_certainty", "deterministic_recovery"]) {
			if (!rescore.out.includes(axis)) errs.push(`rescore.py did not emit the ${axis} axis — the frozen deliverable is the five-axis grid`);
		}
		// The observation sentence IS the deliverable, so it must not
		// carry whichever directory this machine happened to use.
		const leak = /(?:\/Users\/|\/home\/|\/var\/folders\/|\/tmp\/)\S+/.exec(rescore.out);
		if (leak) errs.push(`rescore.py leaked an absolute path into the deliverable: ${leak[0]}`);
	}

	// Running is one promise; still producing the published figures is a
	// different one. expected.json pins the grid, the cost tables, the
	// sensitivity rows and Appendix A's counts.
	for (const [pin, set] of [[null, BATCHES], ["clean", CLEAN]]) {
		const args = pin ? ["--check", "--pin", pin, ...set] : ["--check", ...set];
		const expected = run("expectations.py", args);
		if (expected.code !== 0) errs.push(`expectations.py --check ${pin ?? "(default)"} exited ${expected.code} in a fresh clone:\n${expected.out.trim().split("\n").slice(-6).join("\n")}`);
	}
	const cleanVerify = run("archive.py", ["--verify", ...CLEAN]);
	if (cleanVerify.code !== 0) errs.push(`archive.py --verify (clean replay) exited ${cleanVerify.code}`);

	const metrics = run("metrics.py", BATCHES);
	if (metrics.code !== 0) errs.push(`metrics.py exited ${metrics.code} in a fresh clone:\n${metrics.out.trim().split("\n").slice(-3).join("\n")}`);
	else if (!/cost-weighted/.test(metrics.out)) errs.push(`metrics.py printed no cost table:\n${metrics.out.trim()}`);
} finally {
	rmSync(dir, { recursive: true, force: true });
}

if (errs.length) {
	console.error("[bench-repro] FAIL — the documented commands do not reproduce from the TRACKED tree:");
	for (const e of errs) console.error(`  - ${e}`);
	process.exit(1);
}
console.log(`[bench-repro] OK — ${BATCHES.length} batches re-derive from the tracked archive in a fresh clone`);
