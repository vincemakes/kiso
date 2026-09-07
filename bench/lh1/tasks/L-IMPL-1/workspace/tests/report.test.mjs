import test from "node:test";
import assert from "node:assert/strict";
import { parseJournal } from "../src/journal.mjs";
import { balanceReport, summary } from "../src/report.mjs";

const e = parseJournal(`2026-01-05 | assets:cash | 12.50 | a
2026-01-06 | expenses:food | -3.25 | b
2026-01-08 | assets:bank | 100.00 | d`);

test("balanceReport is sorted, two-space aligned, two decimals", () => {
	assert.equal(balanceReport(e), "assets:bank  100.00\nassets:cash  12.50\nexpenses:food  -3.25");
});
test("summary counts and nets", () => {
	assert.equal(summary(e), "postings 3\naccounts 3\nnet 109.25");
});
