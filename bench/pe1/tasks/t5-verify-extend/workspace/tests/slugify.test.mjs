import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/index.mjs";

test("basic slugging", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("punctuation drops and dash runs collapse", () => {
  assert.equal(slugify("a  --  b!! c"), "a-b-c");
});

test("edge dashes trim", () => {
  assert.equal(slugify("  padded  "), "padded");
});
