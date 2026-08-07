#!/usr/bin/env node
/**
 * Scenario 3 — NO same-row duplicates. The one compositor paints each
 * screen row once per frame (after `\x1b[0K`) — the old two-writer
 * split (body + dock) could paint the same row twice in one frame.
 * The probe: replay the stream into the minimal VT screen (the same
 * emulator the reflow gate uses) and assert every visible row's
 * content appears exactly once — no doubled row.
 */
import { ptyRun } from "../lib/pty-run.mjs";
import { VtScreen } from "../../../apps/cli/tests/helpers/vt-screen.ts";

const bytes = ptyRun({
	events: [{ events: [{ type: "text_delta", text: "the rows are painted once" }, { type: "stop", reason: "end_turn" }] }],
	feeds: [["▌ ", "go\n"]],
	timeout: 20,
	hex: true,
});

let failed = false;
const fail = (msg) => {
	failed = true;
	console.error("FAIL:", msg);
};

const emu = new VtScreen(24, 80);
emu.write(bytes);
const grid = emu.visible();
for (const row of grid) {
	if (row === "") continue;
	// the chrome's two ╌ rows are legitimately identical (the design §03
	// upper + lower) — the duplicate check covers the CONTENT rows
	if (row.includes("╌")) continue;
	const copies = grid.filter((l) => l === row).length;
	if (copies > 1) fail(`row painted ${copies}×: ${JSON.stringify(row.slice(0, 40))}`);
}

if (failed) process.exit(1);
console.log("03 ✓ every visible row painted exactly once");
