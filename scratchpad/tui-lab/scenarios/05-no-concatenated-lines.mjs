#!/usr/bin/env node
/**
 * Scenario 5 — NO concatenated lines. The one compositor's components
 * never share a line; the probe (the same lint the v2d gate uses)
 * reconstructs the line segments from the byte stream and asserts
 * every one matches a known cell format. W6: the box rails
 * and the input row join the known set (the idle screen is the
 * box chrome at 24×80). W21: the panel rows (the divider, the bare
 * └ corner, the paused status) and the SGR-7 user chip join too — the
 * run drives a real approval so the panel actually flows through the
 * lint. The chip's STRIPPED text ("go") is unpatternable (arbitrary
 * user text) — the RAW segment (the \x1b[7m wrap) is the discriminator,
 * checked before the strip.
 */
import { ptyRun, stripANSI } from "../lib/pty-run.mjs";

const out = ptyRun({
	events: [
		{
			events: [
				{ type: "thinking", text: "T".repeat(120) },
				{ type: "text_delta", text: "streaming text" },
				{ type: "tool_call_end", callId: "c1", name: "list_dir", input: {} },
				{ type: "tool_call_end", callId: "c2", name: "asky_read", input: {} },
				{ type: "stop", reason: "tool_use" },
			],
		},
		{ events: [{ type: "text_delta", text: "the tour is done" }, { type: "stop", reason: "end_turn" }] },
	],
	extensions: {
		"asky.mjs": `export default {
	name: "asky",
	approvals: [{ decide: () => ({ action: "ask" }) }],
	tools: [{
		name: "asky_read",
		description: "a tool that needs approval",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: "asky ok", isError: false }),
	}],
};
`,
	},
	feeds: [
		["▌ ", "go\n"],
		["needs approval", "1\n"], // the panel's rule line (the dim run — one contiguous RAW span); the 1 key approves
		["▸ default · /mode to switch", "exit\n"],
	],
	timeout: 30,
});

const CELL_LINE = [
	/^⋯.*$/,
	/^[▖▘▝▗] \S+ .*\d+s?$/,
	/^⏸ \S+ .*$/,
	/^◦ \S+ .*$/,
	/^✓ \S+ {1,2}\(.*, \d+\.\ds\)$/, // the {1,2}: the empty target leaves the verb pad's double space (the W4 idiom — "✓ asky_read  (1 line, ")
	/^✗ \S+ {1,2}\(.*, \d+\.\ds\)$/,
	/^▞.*$/,
	/^│(?: .*)?$/, // v7 W7/W10 + W21: the bounded block's body rows — the settled tail, the W8 window's blank-padded rows, AND the panel's rule/title/args/options/affordance/lead rows (all "│ " gutter rows)
	/^└ .*$/, // v7 W7/W8/W10: the cut/waiting rows (the "  └ " family — "waiting for output", "+N earlier rows · ctrl+r", "capped by …")
	/^└$/, // W21: the panel's corner — the trim eats its trailing space (a bare └ is a known row)
	/^─ .* never truncated ─$/, // W21: the panel's args divider (the ONE gutterless row)
	/^▸ .* · \/mode to switch.*$/,
	/^▸ (run paused|rule input|amend|deny).*$/, // W21: the panel's status rows (the affordance rides the tail)
	/^\/ commands · ↑ history$/,
	/^streaming text.*$/,
	/^the tour is done$/,
	/^session \S+$/,
	/^\[faux mode.*$/,
	/^\[1 extension: .*\]$/, // the extensions banner
	/^(█|▀).*$/,
	/^the coding agent that survives kill -9$/,
	/^v\d+\.\d+\.\d+.*$/,
	/^▌\s?.*$/,
	/^▍\s?.*$/,
	/^│ ›.*│$/, // W6: the input row inside the box (the prompt › — the trim eats the pad)
	/^╭[─]+╮$/, /^╰[─]+╯$/, // W6: the box rails (the corners close the ─ run)
	/^ {0,2}(approved|denied.*)$/,
];

const bad = [];
const segments = out.split(/\x1b\[[0-9;?]*[ABDGKJ]/);
for (const seg of segments) {
	if (/^[0-9;?]*[A-Za-z]$/.test(seg)) continue;
	// the chip: the SGR-7 wrap on the RAW segment — the stripped text is
	// arbitrary user text (unpatternable after the strip); a chip fused
	// with a neighbor would NOT start with the wrap and still fails here
	if (/^\x1b\[7m .*\x1b\[27m/.test(seg)) continue;
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
console.log("05 ✓ no concatenated lines — every segment (incl. the chip and the panel rows) matches a known cell format");
