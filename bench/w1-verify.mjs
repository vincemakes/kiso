#!/usr/bin/env node
/**
 * w1-verify.mjs <work> — W1 (0.49.0 subagents kit, the writers' probe): the
 * leg passes only when all three hold (the owner's ruling, 2026-10-09:
 * adoption is required):
 *
 *   1. ADOPTED — a task directory holds an `apply.jsonl` whose terminal is
 *      `clean`: the parent ran the command its implementer's handoff
 *      printed (`kiso apply-patch`), and the adoption completed;
 *   2. the change is present — src/items/validate.js exports skuPrefix and
 *      tests/sku-prefix.test.js exists;
 *   3. the fixture's tests pass in the workspace (`node --test`).
 *
 * Prints pass | fail; writes the three marks to <work>/w1-marks.json.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "../scripts/is-main.mjs";

/** Every task directory of the leg's sessions (`<id>.tasks/t<N>`). */
export function taskDirs(work) {
	const sessions = join(work, "kiso-home", "sessions");
	if (!existsSync(sessions)) return [];
	return readdirSync(sessions)
		.filter((f) => f.endsWith(".tasks"))
		.flatMap((t) => readdirSync(join(sessions, t)).filter((d) => /^t\d+$/.test(d)).map((d) => join(sessions, t, d)));
}

/** The adoption's terminal, from a task's apply journal (null: none). */
export function applyTerminal(dir) {
	const p = join(dir, "apply.jsonl");
	if (!existsSync(p)) return null;
	const records = readFileSync(p, "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.flatMap((l) => {
			try {
				return [JSON.parse(l)];
			} catch {
				return [];
			}
		});
	return records.find((r) => r.type === "apply_terminal") ?? null;
}

export function w1Marks(work) {
	const repo = join(work, "repo");
	const adopted = taskDirs(work).some((d) => applyTerminal(d)?.outcome === "clean");
	let present = false;
	try {
		present = /export\s+(function\s+skuPrefix|const\s+skuPrefix)/.test(readFileSync(join(repo, "src", "items", "validate.js"), "utf8")) && existsSync(join(repo, "tests", "sku-prefix.test.js"));
	} catch {
		present = false;
	}
	let tests = false;
	try {
		const files = readdirSync(join(repo, "tests")).filter((f) => f.endsWith(".test.js")).map((f) => join("tests", f));
		execFileSync(process.execPath, ["--test", ...files], { cwd: repo, stdio: "ignore", timeout: 120_000 });
		tests = true;
	} catch {
		tests = false;
	}
	return { adopted, present, tests };
}

if (isMain(import.meta.url)) {
	const work = process.argv[2];
	const marks = w1Marks(work);
	writeFileSync(join(work, "w1-marks.json"), `${JSON.stringify(marks)}\n`);
	process.stdout.write(marks.adopted && marks.present && marks.tests ? "pass\n" : "fail\n");
}
