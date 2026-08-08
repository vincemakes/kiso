#!/usr/bin/env node
/**
 * Scenario 2 — the logo rows WHOLE. The banner rows hard-fold at ≤ W
 * (invariant ① — a violation CRASHES the renderer, never a silent
 * truncate): every logo row's full text appears intact in the stream,
 * and no grid row ever carries two logo rows merged (the #17 merge
 * class — the reflow gate pins the resize case).
 */
import { ptyRun } from "../lib/pty-run.mjs";
import { VtScreen } from "../../../apps/cli/tests/helpers/vt-screen.ts";

// W1's BIG tier (render.ts BIG_LOGO_ROWS, indented two). The K row and
// the S row are byte-identical — both must appear (the block is six rows).
const LOGO = [
	"  ██    ██  ██████  ████████  ████████",
	"  ██  ██      ██    ██        ██    ██",
	"  ████        ██    ████████  ██    ██",
	"  ████        ██          ██  ██    ██",
	"  ██  ██      ██          ██  ██    ██",
	"  ██    ██  ██████  ████████  ████████",
];

const bytes = ptyRun({
	events: [{ events: [{ type: "text_delta", text: "the logo rows are whole" }, { type: "stop", reason: "end_turn" }] }],
	feeds: [["▌ ", "go\n"]],
	timeout: 20,
	hex: true,
});

let failed = false;
const fail = (msg) => {
	failed = true;
	console.error("FAIL:", msg);
};

const text = bytes.toString("utf8");
for (const row of [...LOGO, "the coding agent that survives kill -9"]) {
	if (!text.includes(row)) fail(`a logo row not whole in the stream: ${JSON.stringify(row)}`);
}
// the screen: no row ever merges two DIFFERENT logo rows (the fold/merge
// class). The dedupe matters: the K row and the S row are the SAME text
// — a banner row would otherwise count as two matches of one string.
const LOGO_SET = [...new Set(LOGO)];
const emu = new VtScreen(24, 80);
emu.write(bytes);
for (const l of emu.visible()) {
	if (LOGO_SET.filter((row) => l.includes(row)).length > 1) fail("two logo rows merged onto one grid row");
}

if (failed) process.exit(1);
console.log("02 ✓ the logo rows whole in the stream, never merged on the screen");
