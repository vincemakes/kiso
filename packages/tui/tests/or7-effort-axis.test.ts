/**
 * OR-7 — the pick panel's second axis: the key routing and the strip.
 *
 * The PTY gate (`apps/cli/tests/or7-effort-axis-pty.test.ts`) proves the
 * whole chain through the real binary. This file is the unit half, and it
 * carries the two cases the CLI cannot reach today:
 *
 *  - a FORBIDDEN level. Every `forbidden` pair the registry currently
 *    carries is a thinking-"disabled" pair, and the panel applies its
 *    pick as thinking "default" — so no real profile produces a dimmed
 *    index yet. The mechanism is tested here, on the data the contract
 *    defines, rather than left unproven until a row grows one;
 *  - a NULL default. The first-party gpt-6-astra row states no default;
 *    the panel must mark nothing rather than promote the first level.
 */
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";
import { panelAffordanceOf, panelRowsOf } from "../src/ask-panel.js";
import { enabledLevel, modelPickView, stepLevel, type PanelVerdict, type PickOption } from "../src/approval-panel.js";

const enc = (s: string) => new TextEncoder().encode(s);
const strip = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const LADDER = ["low", "medium", "high", "xhigh", "max"] as const;

function view(options: readonly PickOption[]) {
	return modelPickView({ header: "model — current: x", options, typeHint: "type provider/model directly" }, "▸ idle");
}

/** The panel's rows plus its affordance, as the compositor would draw
 *  them — the affordance is where the new gesture is advertised. */
function rows(options: readonly PickOption[], cursor: number, level: number | null): string[] {
	const state = { view: view(options), phase: "options" as const, cursor: 0, pick: { cursor, phase: "options" as const, level } };
	return [...panelRowsOf(state, 100, 14), panelAffordanceOf(state)].map(strip);
}

describe("OR-7 — the level cursor is corrected, never invented", () => {
	it("lands on the asked-for index, steps over a forbidden one, and is null when the option marks none", () => {
		const o: PickOption = { label: "m", levels: LADDER, level: 2, disabled: [3] };
		expect(enabledLevel(o, 2)).toBe(2);
		// asked for the forbidden index: the nearest enabled one, outward
		expect(enabledLevel(o, 3)).toBe(4);
		// past the end: clamped, then corrected
		expect(enabledLevel(o, 9)).toBe(4);
		// a row that marks nothing marks nothing
		expect(enabledLevel({ label: "m", levels: LADDER }, null)).toBeNull();
		// no levels at all: there is no axis to point at
		expect(enabledLevel({ label: "m" }, 0)).toBeNull();
	});

	it("stepping skips forbidden indexes and stops at the ends", () => {
		const o: PickOption = { label: "m", levels: LADDER, disabled: [3] };
		expect(stepLevel(o, 2, 1)).toBe(4); // over the forbidden xhigh
		expect(stepLevel(o, 4, 1)).toBe(4); // the top holds
		expect(stepLevel(o, 0, -1)).toBe(0); // the bottom holds
		// the first press on a row that marks nothing enters at the near end
		expect(stepLevel(o, null, 1)).toBe(0);
		expect(stepLevel(o, null, -1)).toBe(4);
	});
});

describe("OR-7 — the strip", () => {
	it("brackets the cursor, dims the forbidden, and appears only under a row that has levels", () => {
		const options: readonly PickOption[] = [
			{ label: "anthropic/opus", note: "profile: a", levels: LADDER, level: 2, disabled: [3] },
			{ label: "openai-compat/plain", note: "profile: p" },
		];
		const withAxis = rows(options, 0, 2).join("\n");
		expect(withAxis).toContain("effort: low · medium · [high] · xhigh · max");
		// the bracket follows the RUNTIME cursor, not the option's starting
		// index: this row still says `level: 2`, and the state says 4.
		expect(rows(options, 0, 4).join("\n")).toContain("effort: low · medium · high · xhigh · [max]");
		// the affordance names the gesture, the way DC-36 made ↑↓ name theirs
		expect(withAxis).toContain("←→ effort");

		// the second row has no levels: no strip, and the old affordance
		const withoutAxis = rows(options, 1, null).join("\n");
		expect(withoutAxis).not.toContain("effort:");
		expect(withoutAxis).not.toContain("←→ effort");
	});

	it("a null default marks nothing — the panel never promotes a level into one", () => {
		const options: readonly PickOption[] = [{ label: "openai-responses/gpt-6-astra", note: "profile: astra", levels: ["low", "high"] }];
		const text = rows(options, 0, null).join("\n");
		expect(text).toContain("effort: low · high");
		expect(text, "no bracket anywhere: the row states no default").not.toContain("[");
	});

	it("the levelNote is reproduced when the cursor could not land where it was asked", () => {
		const options: readonly PickOption[] = [{ label: "m", note: "profile: m", levels: ["low", "high"], level: 1, levelNote: "effort xhigh → high: the nearest this model supports" }];
		expect(rows(options, 0, 1).join("\n")).toContain("effort xhigh → high: the nearest this model supports");
	});
});

describe("OR-7 — the keys, through the editor's raw-byte routing", () => {
	function open(options: readonly PickOption[]): { editor: Editor; verdict: () => PanelVerdict | null } {
		const editor = new Editor(() => {});
		let v: PanelVerdict | null = null;
		editor.beginPanel(view(options), (got) => {
			v = got;
		});
		return { editor, verdict: () => v };
	}

	const OPTIONS: readonly PickOption[] = [
		{ label: "openai-compat/plain", note: "profile: plain" },
		{ label: "anthropic/opus", note: "profile: axis", levels: LADDER, level: 2 },
	];

	it("↓ re-lands the level cursor on the newly highlighted option; →→ walks it; enter returns both axes", () => {
		const { editor, verdict } = open(OPTIONS);
		// row 0 has no levels, so it marks none
		expect(editor.panelState()?.pick?.level).toBeNull();
		editor.feed(enc("\x1b[B"));
		expect(editor.panelState()?.pick?.cursor).toBe(1);
		expect(editor.panelState()?.pick?.level, "the axis is the highlighted option's own").toBe(2);
		editor.feed(enc("\x1b[C\x1b[C"));
		expect(editor.panelState()?.pick?.level).toBe(4);
		editor.feed(enc("\r"));
		expect(verdict()).toEqual({ action: "picked", result: { index: 1 }, level: 4 });
	});

	it("h and l are the same axis", () => {
		const { editor } = open(OPTIONS);
		editor.feed(enc("\x1b[B"));
		editor.feed(enc("l"));
		expect(editor.panelState()?.pick?.level).toBe(3);
		editor.feed(enc("h"));
		expect(editor.panelState()?.pick?.level).toBe(2);
	});

	it("a pick with no second axis returns exactly what it always did", () => {
		const { editor, verdict } = open(OPTIONS);
		// ← and → on a row with no levels are the composer's keys, and the
		// pick carries no level: the old verdict shape, byte for byte.
		editor.feed(enc("\x1b[C"));
		editor.feed(enc("\r"));
		expect(verdict()).toEqual({ action: "picked", result: { index: 0 } });
	});
});
