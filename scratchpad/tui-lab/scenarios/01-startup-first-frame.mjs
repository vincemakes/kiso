#!/usr/bin/env node
/**
 * Scenario 1 — the startup first frame: SEQUENTIAL emission, NO pre-clear.
 * The v6 first frame draws its rows top-down with CUP, never ED2/ED3J —
 * the shell history above is never wiped. The banner rows appear in
 * ORDER (the logo TOP row before the tagline before the BOTTOM row).
 *
 * W1 re-tiered the banner: at 80 cols the BIG tier renders — the K row
 * and the S row are BYTE-IDENTICAL (the art's own geometry), so the
 * bottom row is the SECOND occurrence of that text in the byte stream.
 */
import { ptyRun, stripANSI } from "../lib/pty-run.mjs";

const out = ptyRun({
	events: [{ events: [{ type: "text_delta", text: "the startup is clean" }, { type: "stop", reason: "end_turn" }] }],
	feeds: [["▌ ", "go\n"]],
	timeout: 20,
	hex: true,
});

let failed = false;
const fail = (msg) => {
	failed = true;
	console.error("FAIL:", msg);
};

if (out.includes("\x1b[2J") || out.includes("\x1b[3J")) fail("a pre-clear sequence (ED2/ED3J) at startup");
const text = out.toString("utf8");
const topRow = "  ██    ██  ██████  ████████  ████████";
// the FIRST occurrence of the top row is the banner's top edge; the
// SECOND is the byte-identical S row, the banner's bottom edge — both
// precede the version + tagline line in the first frame's emission
const idxTop = text.indexOf(topRow);
const idxBottom = idxTop < 0 ? -1 : text.indexOf(topRow, idxTop + 1);
const idxVersion = text.indexOf("the coding agent that survives kill -9");
if (idxTop < 0 || idxBottom < 0 || idxVersion < 0) fail("the logo rows missing");
// V6-2 + W1: the brick rows in order, then the version + tagline line
if (!(idxTop < idxBottom && idxBottom < idxVersion)) fail("the logo rows NOT in order");
if (!stripANSI(text).includes("the startup is clean")) fail("the turn's response missing");

if (failed) process.exit(1);
console.log("01 ✓ the first frame: sequential, no pre-clear, the logo rows in order");
