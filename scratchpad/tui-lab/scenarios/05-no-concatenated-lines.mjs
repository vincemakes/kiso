#!/usr/bin/env node
/**
 * Scenario 5 — NO concatenated lines. The one compositor's components
 * never share a line; the probe (the same lint the v2d gate uses)
 * reconstructs the line segments from the byte stream and asserts
 * every one matches a known cell format.
 */
import { ptyRun, stripANSI } from "../lib/pty-run.mjs";

const out = ptyRun({
	events: [
		{
			events: [
				{ type: "thinking", text: "T".repeat(120) },
				{ type: "text_delta", text: "streaming text" },
				{ type: "tool_call_end", callId: "c1", name: "list_dir", input: {} },
				{ type: "stop", reason: "tool_use" },
			],
		},
		{ events: [{ type: "text_delta", text: "the tour is done" }, { type: "stop", reason: "end_turn" }] },
	],
	feeds: [
		["▌ ", "go\n"],
		["▸ default · /mode to switch", "exit\n"],
	],
	timeout: 30,
});

const CELL_LINE = [
	/^….*$/,
	/^→ \S+ .*[⏸▖▘▝▗]?.*\d*s?$/,
	/^→ \S+ .*⏸$/,
	/^→ \S+ .*$/,
	/^✓ \S+ \(.*, \d+\.\ds\)$/,
	/^✗ \S+ \(.*, \d+\.\ds\)$/,
	/^▞.*$/,
	/^▸ .* · \/mode to switch.*$/,
	/^\/ commands · ↑ history$/,
	/^streaming text.*$/,
	/^the tour is done$/,
	/^session \S+$/,
	/^\[faux mode.*$/,
	/^(█|▀).*$/,
	/^the coding agent that survives kill -9$/,
	/^kiso v\d+\.\d+\.\d+.*$/,
	/^▌\s?.*$/,
	/^▍\s?.*$/,
	/^╌+$/,
	/^ {0,2}(approved|denied.*)$/,
];

const bad = [];
const segments = out.split(/\x1b\[[0-9;?]*[ABDGKJ]/);
for (const seg of segments) {
	if (/^[0-9;?]*[A-Za-z]$/.test(seg)) continue;
	const t = seg
		.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
		.replace(/\[[0-9;]*m/g, "")
		.replace(/\r/g, "")
		.trim();
	if (t === "") continue;
	if (CELL_LINE.some((re) => re.test(t))) continue;
	bad.push(t);
}

if (bad.length > 0) {
	console.error("FAIL: concatenated/unmatched lines:");
	for (const b of bad.slice(0, 8)) console.error("  ", JSON.stringify(b.slice(0, 80)));
	process.exit(1);
}
console.log("05 ✓ no concatenated lines — every segment matches a known cell format");
