import test from "node:test";
import assert from "node:assert/strict";
import { exponent, isCurrency } from "../src/currency.mjs";
import { formatAmount, parseAmount, roundHalfEven } from "../src/money.mjs";

test("hidden: exponents", () => {
	assert.equal(exponent("USD"), 2);
	assert.equal(exponent("JPY"), 0);
	assert.equal(exponent("KWD"), 3);
	assert.throws(() => exponent("XXX"), /unknown currency/);
	assert.equal(isCurrency("EUR"), true);
	assert.equal(isCurrency("eur"), false);
});
test("hidden: parse and format per currency", () => {
	assert.equal(parseAmount("1200", "JPY"), 1200);
	assert.equal(parseAmount("1.234", "KWD"), 1234);
	assert.equal(parseAmount("12.50"), 1250);
	assert.throws(() => parseAmount("1.5", "JPY"), /too many decimals/);
	assert.equal(formatAmount(1200, "JPY"), "1200");
	assert.equal(formatAmount(1234, "KWD"), "1.234");
	assert.equal(formatAmount(-5, "KWD"), "-0.005");
	assert.equal(formatAmount(1250), "12.50");
});
test("hidden: banker's rounding", () => {
	assert.equal(roundHalfEven(2.5), 2);
	assert.equal(roundHalfEven(3.5), 4);
	assert.equal(roundHalfEven(-2.5), -2);
	assert.equal(roundHalfEven(2.51), 3);
	assert.equal(roundHalfEven(7), 7);
});
