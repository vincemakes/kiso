import test from "node:test";
import assert from "node:assert/strict";
import { formatAmount, parseAmount } from "../src/money.mjs";

test("parseAmount reads two decimals into cents", () => {
	assert.equal(parseAmount("12.50"), 1250);
	assert.equal(parseAmount("7"), 700);
	assert.equal(parseAmount("-3.25"), -325);
	assert.equal(parseAmount("0.5"), 50);
});
test("parseAmount rejects garbage", () => {
	assert.throws(() => parseAmount("abc"), /bad amount/);
});
test("formatAmount renders two decimals", () => {
	assert.equal(formatAmount(1250), "12.50");
	assert.equal(formatAmount(-325), "-3.25");
	assert.equal(formatAmount(5), "0.05");
});
