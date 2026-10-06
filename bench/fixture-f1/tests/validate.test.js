import { test } from "node:test";
import assert from "node:assert/strict";
import { validateItem } from "../src/items/validate.js";

test("a good item has no errors", () => {
	assert.deepEqual(validateItem({ sku: "ABC-1234", quantity: 3, name: "bolt" }), []);
});
