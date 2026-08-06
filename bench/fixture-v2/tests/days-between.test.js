// plain node test — the bench convention (same shape as clamp.test.js).
import assert from "node:assert";
import { daysBetween } from "../src/dates.js";
assert.strictEqual(daysBetween("2026/08/05", "2026/08/07"), 2);
assert.strictEqual(daysBetween("2026/08/05", "2026/08/05"), 0);
console.log("days-between ok");
