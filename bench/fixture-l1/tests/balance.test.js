import { test } from "node:test";
import assert from "node:assert/strict";
import { balance } from "../src/ledger.js";
import { settle } from "./settle.js";

test("credits and debits settle to the right balance", async () => {
	await settle(15_000);
	assert.equal(balance([{ kind: "credit", amount: 500 }, { kind: "debit", amount: 120 }]), 380);
});

test("an empty ledger settles to zero", async () => {
	await settle(15_000);
	assert.equal(balance([]), 0);
});
