/**
 * TUI2-R2 slice ④ — C, the /model picker panel.
 *
 * `/model` with no argument used to print a list and a sentence telling
 * you to go edit a JSON file. Everything needed to make it a choice was
 * already on screen; only the choosing was missing. The panel adds the
 * choosing and NOTHING else: the switch itself keeps today's semantics
 * exactly (the session's adapter, in effect on the next turn), because
 * this round is about navigation, not about what a model switch means.
 *
 * The panel rides the W21 slot — the same block, lead, status and
 * affordance machinery the approval and ask panels use. A second panel
 * mechanism would be a second set of geometry bugs.
 *
 * The zero-profile state keeps today's copy VERBATIM. A user with no
 * profiles is exactly the user who needs the config path spelled out,
 * and a redesign that dropped it to look tidier would have removed the
 * one useful thing the old command did.
 *
 * The picker-surface class: new frames only.
 *
 * Graphite P3 (owner, 2026-10-04) re-derived this file: the block is a
 * band (its name carries the header's words, a key row closes it, no
 * closing rule), the input row is the composer's, and the `t` row with its
 * typing phase is gone — a FILTER panel offers a typed `provider/model` as
 * a row of its own (PickSpec.direct). Each moved assertion says so.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";
import { panelAffordanceOf, panelLeadOf, panelRowsOf, panelStatusOf } from "../src/ask-panel.js";
import { modelPickView, type PickSpec } from "../src/approval-panel.js";
import { visibleWidth } from "../src/components.js";

const enc = (s: string) => new TextEncoder().encode(s);
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const SPEC: PickSpec = {
	header: "model — current: deepseek-v4-flash (openai-compat)",
	options: [
		{ label: "deepseek-v4-flash", note: "profile: ds · current" },
		{ label: "claude-sonnet-5", note: "profile: sonnet" },
		{ label: "kimi-k3", note: "profile: kimi" },
	],
};

// P3: the zero-profile panel FILTERS, so a typed provider/model is still a row
const EMPTY: PickSpec = {
	header: "model — current: faux (faux)",
	options: [],
	input: "filter",
	direct: true,
	emptyNote: "no profiles — define models in ~/.kiso/config.json",
};

beforeEach(() => {
	delete process.env.NO_COLOR;
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
});
afterEach(() => {
	delete (process.stdout as { columns?: number }).columns;
	delete (process.stdout as { rows?: number }).rows;
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

describe("TUI2-R2 ④ — the /model panel's block (the picker-surface class)", () => {
	it("the prototype's C-1 frame: the header names the current model, the rows carry their labels, `t` is the escape hatch", () => {
		const view = modelPickView(SPEC, "▸ idle");
		const rows = panelRowsOf({ view, phase: "options", cursor: 0, pick: { cursor: 0, level: null } }, 80, 12).map(strip);
		// R2: the block opens with the same dashed rule it closes with, so
		// every content row moves down one.
		// Graphite §8.1 (R3a): the opening row names the list (`─── model ───`)
		// and the row under it keeps what followed the name
		// MOVED (Graphite P3, the band class — DECLARED): the words after the
		// name ride the band's own row now (`─── model · current: … ───`), so
		// the rows below move up one
		expect(rows[0]!.startsWith("\u2500\u2500\u2500 model \u00b7 current: deepseek-v4-flash (openai-compat) \u2500")).toBe(true);
		// 0.40.1 (the owner's dogfood): a row is its LABEL — the digit column is
		// gone (the digits still pick by visible position, documented in the
		// keys sheet), and the note here is the SPEC's own, which the CLI no
		// longer fills with `profile: <key>`.
		expect(rows[1]).toContain("deepseek-v4-flash");
		expect(rows[1], "no digit column").not.toMatch(/\d+ deepseek-v4-flash/);
		expect(rows[1]).toContain("profile: ds · current");
		expect(rows[2]).toContain("claude-sonnet-5");
		expect(rows[3]).toContain("kimi-k3");
		// DECLARED REVERSALS (P3): no `t` row (a filter offers a typed
		// provider/model as a row of its own), and no closing rule — the key
		// row closes the band, the composer's rail sits under it
		expect(rows.join("\n")).not.toContain(" t type");
		expect(rows.at(-1)).toMatch(/^ {2}\u2191\u2193 move \u00b7 1\u20133 picks \u00b7 \u23ce confirms \u00b7 esc +1\/3$/);
	});

	it("the ZERO-PROFILE state keeps today's copy verbatim — the config path is the one useful thing the old command said", () => {
		const view = modelPickView(EMPTY, "▸ idle");
		const rows = panelRowsOf({ view, phase: "options", cursor: 0, pick: { cursor: 0, level: null } }, 80, 12).map(strip);
		expect(rows.join("\n")).toContain("no profiles — define models in ~/.kiso/config.json");
		// MOVED (P3): the escape hatch is the filter — what is typed becomes a row
		const typed = panelRowsOf({ view, phase: "options", cursor: 0, pick: { cursor: 0, level: null, query: "openai/deepseek-reasoner" } }, 80, 12).map(strip);
		expect(typed.join("\n")).toContain("no profiles — define models in ~/.kiso/config.json");
		expect(typed.join("\n")).toContain("use openai/deepseek-reasoner directly");
	});

	it("the lead, the status and the affordance come from the SAME dispatchers the approval panel uses", () => {
		const view = modelPickView(SPEC, "▸ run paused");
		const options = { view, phase: "options", cursor: 0, pick: { cursor: 0, level: null } } as const;
		// MOVED (P3): a pick leaves the input row to the composer — no lead
		expect(strip(panelLeadOf(options))).toBe("");
		expect(panelStatusOf(options)).toBe("▸ run paused");
		// DC-36: the row NAMES the arrows now. ↑↓ have walked this cursor
		// since this very round (TUI2-R2 ④) and the keys sheet has said so
		// since, but the row a human reads while the panel is up
		// advertised only the digits — which is why the owner read the
		// mode panel as "type the answer". The subject of this case (the
		// three dispatchers are the approval panel's own) is untouched.
		// (P3: the block's key row says the digits; this sentence is the
		// dock-less form, and the typing phase it had is gone with the `t` row)
		expect(strip(panelAffordanceOf(options))).toBe("↑↓ move · ⏎ confirms · esc");
	});

	it("every row fits W at any width — invariant ① can never fire from this block", () => {
		for (const W of [40, 60, 80, 120]) {
			for (const spec of [SPEC, EMPTY]) {
				for (const row of panelRowsOf({ view: modelPickView(spec, "▸ idle"), phase: "options", cursor: 0, pick: { cursor: 1, level: null } }, W, 12)) {
					expect(visibleWidth(row), `W=${W}: ${JSON.stringify(strip(row))}`).toBeLessThanOrEqual(W);
				}
			}
		}
	});
});

describe("TUI2-R2 ④ — the /model panel's keys", () => {
	function open(spec = SPEC) {
		const seen: unknown[] = [];
		const editor = new Editor(() => {});
		editor.beginPanel(modelPickView(spec, "▸ idle"), (v) => seen.push(v));
		return { editor, seen };
	}

	it("a digit picks and ⏎ confirms — the verdict carries the chosen INDEX, never a label the caller must re-match", () => {
		const { editor, seen } = open();
		editor.feed(enc("2"));
		expect(editor.panelState()!.pick!.cursor).toBe(1); // 0-based
		editor.feed(enc("\r"));
		expect(seen).toEqual([{ action: "picked", result: { index: 1 } }]);
	});

	it("↑↓ walk the cursor too — the same list, the other muscle", () => {
		const { editor } = open();
		editor.feed(enc("\x1b[B\x1b[B"));
		expect(editor.panelState()!.pick!.cursor).toBe(2);
		editor.feed(enc("\x1b[A"));
		expect(editor.panelState()!.pick!.cursor).toBe(1);
	});

	it("a digit PAST the list is inert — an eighth option nobody has is never picked", () => {
		const { editor, seen } = open();
		editor.feed(enc("9"));
		expect(editor.panelState()!.pick!.cursor).toBe(0);
		expect(seen).toEqual([]);
	});

	// RE-DERIVED (P3): the `t` line retired into the filter. What it proved —
	// a model no profile names can be typed and picked, and typing alone
	// commits nothing — is proved on the filter's direct row.
	it("a FILTER panel: a typed provider/model is a row; ⏎ commits the typed text, and typing alone commits nothing", () => {
		const filter: PickSpec = { ...SPEC, input: "filter", direct: true };
		const { editor, seen } = open(filter);
		editor.feed(enc("openai/deepseek-reasoner"));
		expect(editor.line()).toBe("openai/deepseek-reasoner"); // the filter is the composer's text
		expect(seen).toEqual([]);
		editor.feed(enc("\r"));
		expect(seen).toEqual([{ action: "picked", result: { custom: "openai/deepseek-reasoner" } }]);
	});

	it("a FILTER narrows the list and ⏎ picks the match under the cursor — a digit is a letter there", () => {
		const filter: PickSpec = { ...SPEC, input: "filter", direct: true };
		const { editor, seen } = open(filter);
		editor.feed(enc("k3"));
		expect(editor.panelState()!.pick!.query).toBe("k3");
		editor.feed(enc("\r"));
		expect(seen).toEqual([{ action: "picked", result: { index: 2 } }]);
	});

	it("esc closes a filter panel at once — one escape, whatever was typed", () => {
		const { editor, seen } = open({ ...SPEC, input: "filter", direct: true });
		editor.feed(enc("kim"));
		editor.feed(enc("\x1b"));
		expect(seen).toEqual([{ action: "cancel" }]);
		expect(editor.panelState()).toBeNull();
		expect(editor.line()).toBe(""); // the stashed composer came back, not the filter
	});

	it("the ZERO-PROFILE panel can still be left, and ⏎ on no options picks nothing", () => {
		const { editor, seen } = open(EMPTY);
		editor.feed(enc("\r"));
		expect(seen).toEqual([]);
		editor.feed(enc("\x1b"));
		expect(seen).toEqual([{ action: "cancel" }]);
	});

	it("the panel swallows stray printable keys — a typed `/` never arms the menu underneath (the W21 rule)", () => {
		const { editor } = open();
		editor.feed(enc("/"));
		expect(editor.menuState()).toBeNull();
		expect(editor.line()).toBe("");
	});
});
