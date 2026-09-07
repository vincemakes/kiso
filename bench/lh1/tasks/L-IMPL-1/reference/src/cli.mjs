#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseJournal } from "./journal.mjs";
import { balanceReport, fxReport, summary } from "./report.mjs";
import { parseRates } from "./rates.mjs";

const USAGE = "usage: cli.mjs <balance|summary|fx> <journal> [--base CCY] [--rates file]";

export function main(argv) {
	const positional = [];
	const flags = {};
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--base" || argv[i] === "--rates") {
			if (argv[i + 1] === undefined) {
				process.stderr.write(`${USAGE}\n`);
				return 2;
			}
			flags[argv[i].slice(2)] = argv[i + 1];
			i += 1;
		} else positional.push(argv[i]);
	}
	const [command, file] = positional;
	const known = command === "balance" || command === "summary" || command === "fx";
	if (!known || file === undefined || (command === "fx" && (flags.base === undefined || flags.rates === undefined))) {
		process.stderr.write(`${USAGE}\n`);
		return 2;
	}
	let entries;
	let rates;
	try {
		entries = parseJournal(readFileSync(file, "utf8"));
		if (flags.rates !== undefined) rates = parseRates(readFileSync(flags.rates, "utf8"));
	} catch (err) {
		process.stderr.write(`parse error: ${err.message}\n`);
		return 3;
	}
	try {
		let out;
		if (command === "balance") out = balanceReport(entries);
		else if (command === "fx") out = fxReport(entries, flags.base, rates);
		else out = flags.base !== undefined ? summary(entries, flags.base, rates ?? new Map()) : summary(entries);
		process.stdout.write(`${out}\n`);
		return 0;
	} catch (err) {
		if (/^no rate:/.test(err.message)) {
			process.stderr.write(`${err.message}\n`);
			return 4;
		}
		process.stderr.write(`error: ${err.message}\n`);
		return 1;
	}
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("cli.mjs")) process.exit(main(process.argv.slice(2)));
