#!/usr/bin/env node
// Scaffold a rule file.
// usage: node scripts/new-rule.mjs <id> <description> [--severity 0|1|2] [--when a,b] [--dir rules]
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [id, description, ...rest] = process.argv.slice(2);
if (!id || !description) {
	process.stderr.write("usage: new-rule.mjs <id> <description> [--severity 0|1|2] [--when a,b] [--dir rules]\n");
	process.exit(1);
}
const opts = { severity: 1, when: "*", dir: "rules" };
for (let i = 0; i < rest.length; i += 2) {
	const flag = rest[i];
	const value = rest[i + 1];
	if (flag === "--severity" && /^[012]$/.test(value ?? "")) opts.severity = Number(value);
	else if (flag === "--when" && value) opts.when = value;
	else if (flag === "--dir" && value) opts.dir = value;
	else {
		process.stderr.write(`new-rule: bad argument ${flag}\n`);
		process.exit(1);
	}
}
const file = join(opts.dir, `${id}.json`);
if (existsSync(file)) {
	process.stderr.write(`new-rule: ${file} exists\n`);
	process.exit(1);
}
const rule = {
	id,
	description,
	severity: opts.severity,
	when: opts.when,
	enabled: "yes",
	pattern: "$^",
	message: "describe the finding",
	fix: null,
	options: {},
	tags: [],
	examples: { bad: [], good: [] },
};
writeFileSync(file, `${JSON.stringify(rule, null, 2)}\n`);
process.stdout.write(`wrote ${file}\n`);
