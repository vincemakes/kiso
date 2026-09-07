#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { StatzError } from "./errors.mjs";
import { parseArgs, USAGE } from "./options.mjs";
import { parseCsv } from "./csv.mjs";
import * as summary from "./commands/summary.mjs";
import * as top from "./commands/top.mjs";
import * as exportRows from "./commands/export.mjs";

const COMMANDS = {
	summary: { run: summary.run, blankLines: "skip" },
	top: { run: top.run, blankLines: "reject" },
	export: { run: exportRows.run, blankLines: "skip" },
};

function main(argv) {
	try {
		const { command, file, options } = parseArgs(argv);
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			throw new StatzError(2, `cannot read ${file}`);
		}
		const { run, blankLines } = COMMANDS[command];
		process.stdout.write(run(parseCsv(text, { blankLines }), options));
		return 0;
	} catch (err) {
		if (err instanceof StatzError && err.usage) {
			process.stderr.write(USAGE);
			return 1;
		}
		process.stderr.write(`statz: ${err.message}\n`);
		return err.code ?? 1;
	}
}

process.exitCode = main(process.argv.slice(2));
