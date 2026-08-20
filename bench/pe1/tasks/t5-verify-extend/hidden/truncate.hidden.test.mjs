import test from "node:test";
import assert from "node:assert/strict";
import { truncateSlug, slugify } from "../src/index.mjs";

test("hidden: exact boundary keeps the whole word", () => {
  assert.equal(truncateSlug("alpha-beta", 10), "alpha-beta");
});

test("hidden: boundary landing ON a dash strips it", () => {
  assert.equal(truncateSlug("alpha-beta-gamma", 11), "alpha-beta");
});

test("hidden: slugify collapses runs (the visible red the round starts from)", () => {
  assert.equal(slugify("x  --  y"), "x-y");
});
