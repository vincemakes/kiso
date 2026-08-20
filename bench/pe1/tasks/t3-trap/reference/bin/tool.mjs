#!/usr/bin/env node
import { loadConfig } from "../src/config.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--config");
if (at === -1 || args[at + 1] === undefined) {
  console.error("usage: tool --config <path> [--verbose]");
  process.exit(2);
}
const path = args[at + 1];
const verbose = args.includes("--verbose");
const res = loadConfig(path);
if (!res.ok) {
  console.error(`bad config: ${res.error}`);
  process.exit(1);
}
if (verbose) console.error(`config loaded from ${path}`);
console.log(`hello, ${res.value.name ?? "world"}`);
