import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const journal = () => {
	const p = join(mkdtempSync(join(tmpdir(), "ledger-")), "j.txt");
	writeFileSync(p, "2026-01-05 | assets:cash | 12.50 | a\n2026-01-06 | expenses:food | -3.25 | b\n");
	return p;
};
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

test("balance prints the report", () => {
	const r = run("balance", journal());
	assert.equal(r.status, 0);
	assert.equal(r.stdout, "assets:cash  12.50\nexpenses:food  -3.25\n");
});
test("usage error exits 2, parse error exits 3", () => {
	assert.equal(run("nope").status, 2);
	const p = join(mkdtempSync(join(tmpdir(), "ledger-")), "bad.txt");
	writeFileSync(p, "not a posting\n");
	assert.equal(run("balance", p).status, 3);
});
