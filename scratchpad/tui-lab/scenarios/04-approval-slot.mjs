#!/usr/bin/env node
/**
 * Scenario 4 — the approval slot TAKES OVER the input row. The v6
 * editorSlot holds exactly one occupant: during an approval the
 * ApprovalPrompt renders the question + the typed answer at the input
 * row (the brick is OUT — a slot swap, not an overlay); when the
 * question clears, the Editor occupant (the brick) returns.
 */
import { ptyRun, stripANSI } from "../lib/pty-run.mjs";

const out = ptyRun({
	events: [
		{
			events: [
				{ type: "tool_call_end", callId: "c1", name: "asky_read", input: {} },
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
		["approve asky_read", "y\n"],
		["▸ default · /mode to switch", "exit\n"],
	],
	timeout: 30,
});

let failed = false;
const fail = (msg) => {
	failed = true;
	console.error("FAIL:", msg);
};

const clean = stripANSI(out);
// the question lives at the input row (the ApprovalPrompt occupant)
if (!clean.includes("approve asky_read? (y/n)")) fail("the approval question missing");
// the approval completed — the answer took effect (the ✓ done line).
// W4 re-baseline: the settled metadata is the RESULT's line count ("1
// line" — settledMeta, components.ts), not the old input "{}".
if (!/✓ asky_read \(1 line, \d+\.\ds\)/.test(clean)) fail("the approval did not complete");
// the brick (the Editor occupant) is present — the slot swapped back
if (!clean.includes("▌ ")) fail("the brick (the Editor occupant) did not return");

if (failed) process.exit(1);
console.log("04 ✓ the approval slot took over the input row and restored the brick");
