#!/usr/bin/env node
/**
 * Scenario 1 — the startup first frame: SEQUENTIAL emission, NO pre-clear.
 * The v6 first frame draws its rows top-down with CUP, never ED2/ED3J —
 * the shell history above is never wiped. The banner rows appear in
 * ORDER (the logo TOP row before the tagline before the BOTTOM row).
 */
import { ptyRun, stripANSI } from "../lib/pty-run.mjs";

const out = ptyRun({
	events: [{ events: [{ type: "text_delta", text: "the startup is clean" }, { type: "stop", reason: "end_turn" }] }],
	feeds: [["▌ ", "go\n"]],
	timeout: 20,
});

let failed = false;
const fail = (msg) => {
	failed = true;
	console.error("FAIL:", msg);
};

if (out.includes("\x1b[2J") || out.includes("\x1b[3J")) fail("a pre-clear sequence (ED2/ED3J) at startup");
const clean = stripANSI(out);
const top = clean.indexOf("█ █ ▀█▀ █▀▀ █▀█");
const tagline = clean.indexOf("the coding agent that survives kill -9");
const bottom = clean.indexOf("▀ ▀ ▀▀▀ ▀▀▀ ▀▀▀");
if (top < 0 || tagline < 0 || bottom < 0) fail("the logo rows missing");
if (!(top < tagline && tagline < bottom)) fail("the logo rows NOT in order");
if (!clean.includes("the startup is clean")) fail("the turn's response missing");

if (failed) process.exit(1);
console.log("01 ✓ the first frame: sequential, no pre-clear, the logo rows in order");
