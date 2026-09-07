#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRules, RuleError } from "./loader.mjs";
import { validateRule } from "./schema.mjs";
import { applicable, check, kindOf } from "./engine.mjs";

const USAGE = "usage: lintr <list|check|validate> [options]\n  list [--kind <kind>] [--rules <dir>]\n  check <file>... [--rules <dir>]\n  validate [--rules <dir>]\n";

class CliError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

function parseArgs(argv) {
	const [command, ...rest] = argv;
	if (!["list", "check", "validate"].includes(command ?? "")) throw new CliError(1, USAGE);
	const options = { rules: "rules", kind: undefined, files: [] };
	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i];
		if (arg === "--rules" || (arg === "--kind" && command === "list")) {
			if (i + 1 >= rest.length) throw new CliError(1, `lintr: missing value for ${arg}\n`);
			options[arg.slice(2)] = rest[++i];
		} else if (arg.startsWith("--")) throw new CliError(1, `lintr: unknown option ${arg}\n`);
		else if (command === "check") options.files.push(arg);
		else throw new CliError(1, USAGE);
	}
	if (command === "check" && options.files.length === 0) throw new CliError(1, USAGE);
	return { command, options };
}

function pad(s, width) {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function table(header, rows) {
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
	return [header, ...rows].map((r) => `${r.map((c, i) => pad(c, widths[i])).join("  ").trimEnd()}\n`).join("");
}

function readRulesDir(dir) {
	try {
		readdirSync(dir);
	} catch {
		throw new CliError(2, `lintr: cannot read rules directory ${dir}\n`);
	}
	try {
		return loadRules(dir);
	} catch (err) {
		if (err instanceof RuleError) throw new CliError(3, `lintr: ${err.message}\n`);
		throw err;
	}
}

function list(options) {
	let rules = readRulesDir(options.rules);
	if (options.kind !== undefined) rules = applicable(rules, options.kind);
	const rows = rules.map((r) => [r.id, r.level, r.files.join(","), r.deprecated ? "deprecated" : r.enabled ? "" : "disabled"]);
	return { out: table(["id", "level", "files", "note"], rows), code: 0 };
}

function checkFiles(options) {
	const rules = readRulesDir(options.rules);
	let out = "";
	let total = 0;
	let errors = 0;
	for (const file of options.files) {
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			throw new CliError(2, `lintr: cannot read ${file}\n`);
		}
		for (const f of check(text, kindOf(file), rules)) {
			out += `${file}:${f.line}: ${f.level} ${f.ruleId}: ${f.message}\n`;
			total += 1;
			if (f.level === "error") errors += 1;
		}
	}
	out += `${total} findings, ${errors} errors\n`;
	return { out, code: errors > 0 ? 1 : 0 };
}

function validate(options) {
	let names;
	try {
		names = readdirSync(options.rules).filter((f) => f.endsWith(".json")).sort();
	} catch {
		throw new CliError(2, `lintr: cannot read rules directory ${options.rules}\n`);
	}
	let out = "";
	for (const name of names) {
		let data;
		try {
			data = JSON.parse(readFileSync(join(options.rules, name), "utf8"));
		} catch (err) {
			out += `${name}: invalid JSON (${err.message})\n`;
			continue;
		}
		for (const problem of validateRule(name, data)) out += `${name}: ${problem}\n`;
	}
	if (out === "") {
		try {
			loadRules(options.rules);
		} catch (err) {
			if (!(err instanceof RuleError)) throw err;
			out += `${err.file}: ${err.reason}\n`;
		}
	}
	if (out !== "") return { out, code: 1 };
	return { out: `${names.length} rules ok\n`, code: 0 };
}

function main(argv) {
	try {
		const { command, options } = parseArgs(argv);
		const { out, code } = command === "list" ? list(options) : command === "check" ? checkFiles(options) : validate(options);
		process.stdout.write(out);
		return code;
	} catch (err) {
		if (err instanceof CliError) {
			process.stderr.write(err.message);
			return err.code;
		}
		throw err;
	}
}

process.exitCode = main(process.argv.slice(2));
