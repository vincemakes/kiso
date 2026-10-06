import { test } from "node:test";
import assert from "node:assert/strict";
import { balance } from "../src/ledger.js";
import { settle } from "./settle.js";

test("a month of entries reports its closing balance", async () => {
	await settle(15_000);
	const month = Array.from({ length: 30 }, (_, i) => ({ kind: i % 3 === 0 ? "debit" : "credit", amount: 100 }));
	assert.equal(balance(month), 1_000);
});
