#!/usr/bin/env node
/**
 * Scenario 4 — the W21 approval panel takes over the input row. The
 * bounded block replaces the running tool's live window (the retired
 * y/n slot is gone); the panel's lead (the 1-3> selector) owns the
 * input row while up. This drives the SELECTOR path BOTH ways: the
 * first ask is approved with the 1 key, the second (a distinct call —
 * the args row is the only byte unique to its panel) is denied with
 * the 3 key. The bare No aborts the run (chat.ts — the deny
 * asymmetry): the second cell stays at the ⏸ wait, the final turn
 * never streams, and the idle status returns (the panel closed).
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
		{
			events: [
				{ type: "text_delta", text: "the second ask" },
				{ type: "tool_call_end", callId: "c2", name: "asky_read", input: { file: "two" } },
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
		// the rule line's dim run is ONE contiguous RAW span ("needs
		// approval") — the "asky_read needs approval" needle is
		// SGR-interrupted and never matches. The 1 key approves.
		["needs approval", "1\n"],
		// the second panel: the args row (pretty-printed "file": "two")
		// is its ONLY unique byte — the rule line and the 1-3> lead are
		// byte-identical across the panels, and anything that paints
		// before the panel opens (the settle, the text, the ⏸) hits the
		// closed editor. The 3 key denies.
		["\"file\": \"two\"", "3\n"],
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
// the panel surface — the W21 bounded block (the first ask)
if (!clean.includes("asky_read needs approval — asked by asky")) fail("the panel rule line missing");
if (!clean.includes(" 1 Yes   2 Yes, don't ask again for asky_read   3 No")) fail("the panel options row missing");
if (!clean.includes("tab amend · esc cancel")) fail("the panel affordance missing");
if (!clean.includes("─ the full args — never truncated ─")) fail("the panel args divider missing");
if (!clean.includes("1-3> ")) fail("the panel lead missing (the input row is the 1-3> selector)");
if (!clean.includes("▸ run paused")) fail("the panel status missing");
// the APPROVE via the 1 selector key — the call ran and settled. W4: the
// settled metadata is the RESULT's line count; the empty target leaves
// the verb pad's double space.
if (!/✓ asky_read {2}\(1 line, \d+\.\ds\)/.test(clean)) fail("the approve did not complete");
// the DENY via the 3 selector key — the second call never ran (the ⏸
// wait stays — the abort settles the pause first, then dies — the final
// turn never streams), and the idle status returned (the panel closed).
if (!clean.includes("⏸ asky_read {\"file\":\"two\"}")) fail("the denied call did not stay at the ⏸ wait");
if (clean.includes("the tour is done")) fail("the bare deny did not abort the run");
if (!clean.includes("▸ default · /mode to switch · faux")) fail("the idle status did not return");
// the brick (the Editor occupant) — the panel lead left the input row
if (!clean.includes("▌ ")) fail("the brick (the Editor occupant) did not return");

if (failed) process.exit(1);
console.log("04 ✓ the panel selector path — the 1 approve AND the 3 deny — and the brick's return");
