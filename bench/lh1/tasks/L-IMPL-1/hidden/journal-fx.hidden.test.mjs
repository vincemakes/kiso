import test from "node:test";
import assert from "node:assert/strict";
import { parseJournal } from "../src/journal.mjs";
import { balances, balancesByCurrency } from "../src/ledger.mjs";
import { balanceReport, fxReport, summary } from "../src/report.mjs";
import { parseRates } from "../src/rates.mjs";

test("hidden: the fifth field and the default-currency header", () => {
	const e = parseJournal("; default-currency: EUR\n2026-01-05 | assets:cash | 12.50 | a\n2026-01-06 | assets:bank | 1200 | b | JPY\n");
	assert.deepEqual(e[0], { date: "2026-01-05", account: "assets:cash", amount: 1250, memo: "a", currency: "EUR" });
	assert.equal(e[1].currency, "JPY");
	assert.equal(e[1].amount, 1200);
	assert.equal(parseJournal("2026-01-05 | assets:cash | 1.00")[0].currency, "USD");
	assert.throws(() => parseJournal("2026-01-05 | assets:cash | 1.00 | m | XXX"), /unknown currency/);
});
test("hidden: per-currency balances and reports", () => {
	const e = parseJournal("2026-01-05 | assets:cash | 10.00 | a | EUR\n2026-01-06 | assets:cash | 5.00 | b\n2026-01-07 | assets:cash | 2.50 | c | EUR\n");
	const b = balancesByCurrency(e);
	assert.equal(b.get("assets:cash").get("EUR"), 1250);
	assert.equal(b.get("assets:cash").get("USD"), 500);
	assert.throws(() => balances(e), /mixed currencies/);
	assert.equal(balanceReport(e), "assets:cash  12.50 EUR\nassets:cash  5.00 USD");
	const rates = parseRates("EUR USD 1.10\n");
	assert.equal(fxReport(e, "USD", rates), "assets:cash  18.75 USD\nTOTAL  18.75 USD");
	assert.equal(summary(e, "USD", rates), "postings 3\naccounts 1\nnet 18.75 USD");
});
test("hidden: USD-only output is byte-identical to the original", () => {
	const e = parseJournal("2026-01-05 | assets:cash | 12.50 | a\n2026-01-06 | expenses:food | -3.25 | b\n");
	assert.equal(balanceReport(e), "assets:cash  12.50\nexpenses:food  -3.25");
	assert.equal(summary(e), "postings 2\naccounts 2\nnet 9.25");
});
