#!/usr/bin/env node
/**
 * f1-verify.mjs <work> — F1 (breadth): the leg's FINAL answer (the main
 * session's, never a child's — final-answer.mjs) carries all six facts,
 * and the repository is unchanged. Prints pass | fail; writes the per-
 * question marks to <work>/f1-marks.json.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { finalAnswer } from "./final-answer.mjs";
import { isMain } from "../scripts/is-main.mjs";

/** Each question's facts — all must appear in the answer. */
export const F1_FACTS = [
	{ q: 1, all: [/\b25\b/, /\b200\b/] },
	{ q: 2, all: [/\b[A-Z]{3}-\d{4}\b/] },
	{ q: 3, all: [/\b404\b/, /\b204\b/] },
	{ q: 4, all: [/INVENTORY_DB/, /data\/inventory\.db/] },
	{ q: 5, all: [/\b4\b/, /\b150\s*(ms|milliseconds)?\b/i, /\b300\s*(ms|milliseconds)?\b/i] },
	{ q: 6, all: [/reports\/summary(\.js)?|summary\.js/] },
];

export function marks(answer) {
	return F1_FACTS.map(({ q, all }) => ({ q, ok: all.every((re) => re.test(answer)) }));
}

if (isMain(import.meta.url)) {
	const work = process.argv[2];
	let answer = "";
	try {
		answer = finalAnswer("kiso", work);
	} catch {
		answer = "";
	}
	const m = marks(answer);
	let clean = false;
	try {
		clean = execFileSync("git", ["-C", join(work, "repo"), "status", "--porcelain"], { encoding: "utf8" }).trim() === "";
	} catch {
		clean = false;
	}
	writeFileSync(join(work, "f1-marks.json"), `${JSON.stringify({ marks: m, repoUnchanged: clean }, null, 1)}\n`);
	console.log(answer !== "" && clean && m.every((x) => x.ok) ? "pass" : "fail");
}
