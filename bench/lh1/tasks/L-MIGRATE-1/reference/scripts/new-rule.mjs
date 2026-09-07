#!/usr/bin/env node
// Scaffold a rule file (format version 2).
// usage: node scripts/new-rule.mjs <id> <description> [--level off|warn|error] [--files a,b] [--dir rules]
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [id, description, ...rest] = process.argv.slice(2);
if (!id || !description) {
	process.stderr.write("usage: new-rule.mjs <id> <description> [--level off|warn|error] [--files a,b] [--dir rules]\n");
	process.exit(1);
}
const opts = { level: "warn", files: "*", dir: "rules" };
for (let i = 0; i < rest.length; i += 2) {
	const flag = rest[i];
	const value = rest[i + 1];
	if (flag === "--level" && ["off", "warn", "error"].includes(value ?? "")) opts.level = value;
	else if (flag === "--files" && value) opts.files = value;
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
	schema: 2,
	id,
	description,
	level: opts.level,
	files: opts.files.trim() === "*" ? ["*"] : opts.files.split(",").map((s) => s.trim()).filter(Boolean),
	enabled: true,
	match: { pattern: "$^", message: "describe the finding" },
	fix: null,
	options: {},
	tags: [],
	examples: { bad: [], good: [] },
};
writeFileSync(file, `${JSON.stringify(rule, null, 2)}\n`);
process.stdout.write(`wrote ${file}\n`);
