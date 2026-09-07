import test from "node:test";
import assert from "node:assert/strict";
import { parseJournal } from "../src/journal.mjs";
import { balances, totalsByPrefix } from "../src/ledger.mjs";

const e = parseJournal(`2026-01-05 | assets:cash | 12.50 | a
2026-01-06 | expenses:food | -3.25 | b
2026-01-07 | assets:cash | 1.00 | c
2026-01-08 | assets:bank | 100.00 | d`);

test("balances sums per account", () => {
	const b = balances(e);
	assert.equal(b.get("assets:cash"), 1350);
	assert.equal(b.get("expenses:food"), -325);
});
test("totalsByPrefix sums a subtree", () => {
	assert.equal(totalsByPrefix(e, "assets:"), 11350);
	assert.equal(totalsByPrefix(e, "expenses:"), -325);
});
