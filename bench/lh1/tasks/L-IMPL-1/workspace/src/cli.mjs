#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseJournal } from "./journal.mjs";
import { balanceReport, summary } from "./report.mjs";

const USAGE = "usage: cli.mjs <balance|summary> <journal>";

export function main(argv) {
	const [command, file] = argv;
	if ((command !== "balance" && command !== "summary") || file === undefined) {
		process.stderr.write(`${USAGE}\n`);
		return 2;
	}
	let entries;
	try {
		entries = parseJournal(readFileSync(file, "utf8"));
	} catch (err) {
		process.stderr.write(`parse error: ${err.message}\n`);
		return 3;
	}
	process.stdout.write(`${command === "balance" ? balanceReport(entries) : summary(entries)}\n`);
	return 0;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("cli.mjs")) process.exit(main(process.argv.slice(2)));
