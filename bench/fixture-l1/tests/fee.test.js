import { test } from "node:test";
import assert from "node:assert/strict";
import { fee, net } from "../src/ledger.js";
import { settle } from "./settle.js";

test("a fee on a round amount", async () => {
	await settle(15_000);
	assert.equal(fee(10_000, 0.025), 250);
});

test("a fee rounds half up to the cent", async () => {
	await settle(15_000);
	assert.equal(fee(1_010, 0.025), 25); // 25.25 → 25
	assert.equal(fee(1_030, 0.025), 26); // 25.75 → 26
});

test("net is the amount less its fee", async () => {
	await settle(15_000);
	assert.equal(net(1_030, 0.025), 1_004);
});
