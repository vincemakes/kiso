import test from "node:test";
import assert from "node:assert/strict";
import { convert, parseRates } from "../src/rates.mjs";

const rates = parseRates("; rates\nEUR USD 1.10\nUSD JPY 150\n");

test("hidden: direct, inverse, identity, exponents", () => {
	assert.equal(convert(1000, "EUR", "USD", rates), 1100);
	assert.equal(convert(1100, "USD", "EUR", rates), 1000);
	assert.equal(convert(150, "USD", "JPY", rates), 225);
	assert.equal(convert(225, "JPY", "USD", rates), 150);
	assert.equal(convert(777, "EUR", "EUR", rates), 777);
});
test("hidden: ties round to even after conversion (exact arithmetic, no float drift)", () => {
	const r = parseRates("JPY USD 0.0125\n"); // 1 JPY = 1.25 cents
	assert.equal(convert(2, "JPY", "USD", r), 2); // 2.5 cents → 2 (even)
	assert.equal(convert(6, "JPY", "USD", r), 8); // 7.5 cents → 8 (even)
	assert.equal(convert(1, "JPY", "USD", r), 1); // 1.25 → 1
});
test("hidden: a missing rate throws no rate", () => {
	assert.throws(() => convert(1, "GBP", "USD", rates), /no rate: GBP->USD/);
});
