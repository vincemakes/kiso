import { reportLine } from "../src/report.js";
import assert from "node:assert";
const line = reportLine({ name: "Ada", email: "a@b.c" }, 3);
assert.ok(line.includes("Ada <a@b.c>"));
console.log("user ok");
