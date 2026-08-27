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
	typeHint: "type provider/model directly",
};

const EMPTY: PickSpec = {
	header: "model — current: faux (faux)",
	options: [],
	typeHint: "type provider/model directly (e.g. openai/deepseek-reasoner)",
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
	it("the prototype's C-1 frame: the header names the current model, the options are numbered, `t` is the escape hatch", () => {
		const view = modelPickView(SPEC, "▸ idle");
		const rows = panelRowsOf({ view, phase: "options", cursor: 0, pick: { cursor: 0, phase: "options" } }, 80, 12).map(strip);
		// R2: the block opens with the same dashed rule it closes with, so
		// every content row moves down one.
		expect(rows[0]!.startsWith("\u2500")).toBe(true);
		expect(rows[1]).toContain("model — current: deepseek-v4-flash (openai-compat)");
		expect(rows[2]).toContain(" 1 deepseek-v4-flash");
		expect(rows[2]).toContain("profile: ds · current");
		expect(rows[3]).toContain(" 2 claude-sonnet-5");
		expect(rows[4]).toContain(" 3 kimi-k3");
		expect(rows[5]).toContain(" t type provider/model directly");
		expect(rows.at(-1)!.startsWith("\u2500")).toBe(true); // the block's own bottom rule
	});

	it("the ZERO-PROFILE state keeps today's copy verbatim — the config path is the one useful thing the old command said", () => {
		const view = modelPickView(EMPTY, "▸ idle");
		const rows = panelRowsOf({ view, phase: "options", cursor: 0, pick: { cursor: 0, phase: "options" } }, 80, 12).map(strip);
		expect(rows.join("\n")).toContain("no profiles — define models in ~/.kiso/config.json");
		expect(rows.join("\n")).toContain("t type provider/model directly (e.g. openai/deepseek-reasoner)");
	});

	it("the lead, the status and the affordance come from the SAME dispatchers the approval panel uses", () => {
		const view = modelPickView(SPEC, "▸ run paused");
		const options = { view, phase: "options", cursor: 0, pick: { cursor: 0, phase: "options" } } as const;
		expect(strip(panelLeadOf(options))).toBe("1-3> ");
		expect(panelStatusOf(options)).toBe("▸ run paused");
		expect(panelAffordanceOf(options)).toBe("digits pick · ⏎ confirms · esc");
		const typing = { view, phase: "options", cursor: 0, pick: { cursor: 0, phase: "custom" } } as const;
		expect(strip(panelLeadOf(typing))).toBe("provider/model: ");
		expect(panelAffordanceOf(typing)).toBe("enter commits · esc backs out");
	});

	it("every row fits W at any width — invariant ① can never fire from this block", () => {
		for (const W of [40, 60, 80, 120]) {
			for (const spec of [SPEC, EMPTY]) {
				for (const row of panelRowsOf({ view: modelPickView(spec, "▸ idle"), phase: "options", cursor: 0, pick: { cursor: 1, phase: "options" } }, W, 12)) {
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

	it("`t` opens the type-it line; ⏎ commits the typed text, and an EMPTY line commits nothing", () => {
		const { editor, seen } = open();
		editor.feed(enc("t"));
		expect(editor.panelState()!.pick!.phase).toBe("custom");
		editor.feed(enc("openai/deepseek-reasoner\r"));
		expect(seen).toEqual([{ action: "picked", result: { custom: "openai/deepseek-reasoner" } }]);
		const second = open();
		second.editor.feed(enc("t\r"));
		expect(second.seen).toEqual([]); // still typing — an empty line is not a choice
		expect(second.editor.panelState()!.pick!.phase).toBe("custom");
	});

	it("esc backs out of the type-it line first, then cancels the panel — two escapes, two different meanings", () => {
		const { editor, seen } = open();
		editor.feed(enc("t"));
		editor.feed(enc("\x1b"));
		expect(editor.panelState()!.pick!.phase).toBe("options");
		expect(seen).toEqual([]);
		editor.feed(enc("\x1b"));
		expect(seen).toEqual([{ action: "cancel" }]);
		expect(editor.panelState()).toBeNull();
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
