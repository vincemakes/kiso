import test from "node:test";
import assert from "node:assert/strict";
import { parseJournal } from "../src/journal.mjs";

const J = `; a comment
2026-01-05 | assets:cash | 12.50 | opening
2026-01-06 | expenses:food | -3.25 | lunch
2026-01-07 | assets:cash | 1.00
`;

test("parseJournal reads postings and skips comments", () => {
	const e = parseJournal(J);
	assert.equal(e.length, 3);
	assert.equal(e[0].date, "2026-01-05");
	assert.equal(e[0].account, "assets:cash");
	assert.equal(e[0].amount, 1250);
	assert.equal(e[0].memo, "opening");
	assert.equal(e[2].memo, "");
});
test("parseJournal rejects bad dates and accounts", () => {
	assert.throws(() => parseJournal("26-1-5 | assets:cash | 1.00"), /bad date/);
	assert.throws(() => parseJournal("2026-01-05 | Assets | 1.00"), /bad account/);
});
