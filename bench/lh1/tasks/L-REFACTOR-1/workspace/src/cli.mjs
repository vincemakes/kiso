#!/usr/bin/env node
import { summary } from "./summary.mjs";
import { top } from "./top.mjs";
import { exportRows } from "./export.mjs";

const USAGE = "usage: statz <summary|top|export> <file> [options]\n";

function fail(code, message) {
	const err = new Error(message);
	err.code = code;
	return err;
}

function main(argv) {
	const [command, file, ...rest] = argv;
	if (!command || !file) {
		process.stderr.write(USAGE);
		return 1;
	}
	let out;
	try {
		if (command === "summary") {
			const options = { unit: undefined, sort: "name" };
			for (let i = 0; i < rest.length; i += 1) {
				const flag = rest[i];
				if (flag === "--unit") {
					if (i + 1 >= rest.length) throw fail(1, "missing value for --unit");
					options.unit = rest[++i];
				} else if (flag === "--sort") {
					if (i + 1 >= rest.length) throw fail(1, "missing value for --sort");
					const v = rest[++i];
					if (v !== "name" && v !== "mean") throw fail(1, "bad value for --sort");
					options.sort = v;
				} else throw fail(1, `unknown option ${flag}`);
			}
			out = summary(file, options);
		} else if (command === "top") {
			const options = { n: 3, by: "mean" };
			for (let i = 0; i < rest.length; i += 1) {
				const flag = rest[i];
				if (flag === "--n") {
					if (i + 1 >= rest.length) throw fail(1, "missing value for --n");
					const v = rest[++i];
					if (!/^[1-9][0-9]*$/.test(v)) throw fail(1, "bad value for --n");
					options.n = Number(v);
				} else if (flag === "--by") {
					if (i + 1 >= rest.length) throw fail(1, "missing value for --by");
					const v = rest[++i];
					if (v !== "mean" && v !== "max") throw fail(1, "bad value for --by");
					options.by = v;
				} else throw fail(1, `unknown option ${flag}`);
			}
			out = top(file, options);
		} else if (command === "export") {
			const options = { format: "json" };
			for (let i = 0; i < rest.length; i += 1) {
				const flag = rest[i];
				if (flag === "--format") {
					if (i + 1 >= rest.length) throw fail(1, "missing value for --format");
					const v = rest[++i];
					if (v !== "json" && v !== "csv") throw fail(1, "bad value for --format");
					options.format = v;
				} else throw fail(1, `unknown option ${flag}`);
			}
			out = exportRows(file, options);
		} else {
			process.stderr.write(USAGE);
			return 1;
		}
	} catch (err) {
		process.stderr.write(`statz: ${err.message}\n`);
		return err.code ?? 1;
	}
	process.stdout.write(out);
	return 0;
}

process.exitCode = main(process.argv.slice(2));
