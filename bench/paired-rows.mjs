#!/usr/bin/env node
/**
 * paired-rows.mjs <round-dir> <task> <rows.json> — split an extractor's
 * rows into the rc and control sets paired-compare.mjs reads.
 *
 * A leg's run id is its arm and its pair (`rc3`, `ctl3`; a re-run of a void
 * pair `rc3b`, `ctl3b`); the pair id is what is left (`3`, `3b`). A leg
 * with a `void` file is not a data point and is dropped — with its pair,
 * since a pair with one leg compares nothing. Writes <task>-rc.json and
 * <task>-ctl.json into the round directory and prints what it dropped.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "../scripts/is-main.mjs";

export function split(rows, isVoid) {
	const arm = (run) => (/^rc/.test(run) ? "rc" : /^ctl/.test(run) ? "ctl" : null);
	const pairId = (run) => run.replace(/^(rc|ctl)/, "");
	const voidPairs = new Set(rows.filter((r) => isVoid(r.run)).map((r) => pairId(r.run)));
	const keep = rows.filter((r) => arm(r.run) !== null && !voidPairs.has(pairId(r.run)));
	const ids = (a) => new Set(keep.filter((r) => arm(r.run) === a).map((r) => pairId(r.run)));
	const both = [...ids("rc")].filter((id) => ids("ctl").has(id));
	const pick = (a) => keep.filter((r) => arm(r.run) === a && both.includes(pairId(r.run))).map((r) => ({ ...r, run: pairId(r.run) }));
	return { rc: pick("rc"), ctl: pick("ctl"), dropped: [...voidPairs] };
}

if (isMain(import.meta.url)) {
	const [round, task, rowsFile] = process.argv.slice(2);
	const rows = JSON.parse(readFileSync(rowsFile, "utf8")).filter((r) => r.task === task);
	const { rc, ctl, dropped } = split(rows, (run) => existsSync(join(round, `kiso-${task}-${run}`, "void")));
	writeFileSync(join(round, `${task}-rc.json`), `${JSON.stringify(rc, null, 1)}\n`);
	writeFileSync(join(round, `${task}-ctl.json`), `${JSON.stringify(ctl, null, 1)}\n`);
	console.log(`${task}: ${rc.length} pairs; dropped (void) pairs: ${dropped.length === 0 ? "none" : dropped.join(", ")}`);
}
