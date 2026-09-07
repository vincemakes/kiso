import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const files = (() => {
	const out = [];
	const walk = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else out.push(p);
		}
	};
	walk("src");
	return out.sort();
})();
const read = (p) => readFileSync(p, "utf8");
const filesContaining = (needle) => files.filter((f) => read(f).includes(needle));
const count = (needle) => files.reduce((n, f) => n + read(f).split(needle).length - 1, 0);

test("hidden: the old modules are gone", () => {
	for (const p of ["src/summary.mjs", "src/top.mjs", "src/export.mjs", "src/util.mjs"]) assert.equal(existsSync(p), false, `${p} still exists`);
});

test("hidden: the file system is touched only by src/cli.mjs", () => {
	assert.deepEqual(filesContaining("node:fs"), ["src/cli.mjs"]);
	assert.deepEqual(
		files.filter((f) => f !== "src/cli.mjs" && (read(f).includes('"fs"') || read(f).includes("'fs'"))),
		[],
	);
});

test("hidden: `process.` occurs only in src/cli.mjs", () => {
	assert.deepEqual(filesContaining("process."), ["src/cli.mjs"]);
});

test("hidden: .toFixed( exactly once, in src/format.mjs", () => {
	assert.equal(count(".toFixed("), 1);
	assert.deepEqual(filesContaining(".toFixed("), ["src/format.mjs"]);
});

test("hidden: the header literal exactly once, in src/csv.mjs", () => {
	assert.equal(count("name,value,unit,tags"), 1);
	assert.deepEqual(filesContaining("name,value,unit,tags"), ["src/csv.mjs"]);
});

test("hidden: every module of the layout exists with its exports", async () => {
	const expect = {
		"src/errors.mjs": ["StatzError"],
		"src/csv.mjs": ["parseCsv"],
		"src/stats.mjs": ["aggregate", "median"],
		"src/format.mjs": ["fmt", "pad", "table"],
		"src/options.mjs": ["parseArgs", "USAGE"],
		"src/commands/summary.mjs": ["run"],
		"src/commands/top.mjs": ["run"],
		"src/commands/export.mjs": ["run"],
		"src/index.mjs": ["parseCsv", "aggregate", "median", "StatzError", "parseArgs", "summary", "top", "exportRows"],
	};
	for (const [file, names] of Object.entries(expect)) {
		assert.equal(existsSync(file), true, `${file} missing`);
		const mod = await import(pathToFileURL(resolve(file)).href);
		for (const n of names) assert.equal(typeof mod[n] === "function" || typeof mod[n] === "string", true, `${file} does not export ${n}`);
	}
});
