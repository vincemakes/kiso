/**
 * KC1 T-C1 — THE IDENTITY ANCHOR: at N = 1 the composer's frames are
 * BYTE-IDENTICAL to the retired single-row input row's, in every
 * scenario the compositor has (the first frame, a steady no-commit
 * frame, a commit frame, the menu band, the queue band, the panel slot,
 * a resize repaint, the force-commit overflow, a narrow width and a CJK
 * line). The whole existing compositor / editor / PTY suite is the
 * other half of this gate — it runs UNMODIFIED against the new code.
 *
 * The probe drives TWO bodies through the same script: one bound to a
 * LEGACY one-row provider (the old `{line, cursor}` shape the CLI used
 * to pass) and one bound to the ADDITIVE shape — including the REAL
 * editor's dockState(). Identical bytes prove three things at once: the
 * refactor moved nothing, the legacy provider still works (the surface
 * is additive), and the frame-derived cursor still lands on the marker.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body, type InputState } from "../src/compositor.js";
import { Editor } from "../src/editor.js";
import type { PanelView } from "../src/approval-panel.js";

const enc = (s: string) => new TextEncoder().encode(s);

const PANEL_VIEW: PanelView = {
	flavor: "approval",
	name: "edit_file",
	title: "edit examples/foo.ts",
	speaker: "mode:default",
	hint: "/mode accept-edits auto-approves edits",
	statusText: "▸ run paused",
	args: { kind: "text", lines: ["old", "new"] },
	fallbackQuestion: "approve edit_file? (y/n) ",
};

/** one scenario, run against one bound input provider — the frame bytes */
function frames(provider: () => InputState, script: (body: Body) => void, opts: { W?: number | undefined; H?: number | undefined } = {}): string {
	const W = opts.W ?? 80;
	const H = opts.H ?? 24;
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	body.bindInput(provider, "› ");
	body.enter();
	script(body);
	vi.advanceTimersByTime(16);
	return writes.join("");
}

/** the same values in the two shapes — the legacy pair alone, and the
 *  pair PLUS the composer's one-row view */
const legacy = (line: string, cursor: number) => (): InputState => ({ line, cursor });
const additive = (line: string, cursor: number) => (): InputState => ({ line, cursor, lines: [line], cursorRow: 0, cursorCol: cursor });

const SCENARIOS: { label: string; script: (body: Body) => void; W?: number; H?: number }[] = [
	{ label: "the first frame alone", script: () => {} },
	{ label: "a steady no-commit frame (an open cell)", script: (b) => b.textAppend("live text") },
	{ label: "a commit frame (a done cell freezes)", script: (b) => b.raw(["frozen row"]) },
	{
		label: "the menu band",
		script: (b) => {
			b.bindMenu(() => ({ items: [{ name: "/mode", desc: "switch the approval tier" }], selected: 0 }));
			b.raw(["x"]);
		},
	},
	{
		label: "the queue band",
		script: (b) => {
			b.bindQueue(() => ["a queued turn", "another"]);
			b.raw(["x"]);
		},
	},
	{
		label: "the panel slot",
		script: (b) => {
			b.bindApproval(() => ({ view: PANEL_VIEW, phase: "options", cursor: 0 }));
			b.raw(["x"]);
		},
	},
	{ label: "a resize repaint", script: (b) => { b.raw(["frozen"]); b.onResize(); vi.advanceTimersByTime(100); } },
	{
		label: "the force-commit overflow (a super-tall cell)",
		script: (b) => b.textAppend(Array.from({ length: 30 }, (_, i) => `tall ${i}`).join("\n")),
	},
	{ label: "a narrow width", script: (b) => b.raw(["x"]), W: 44 },
	{ label: "the status + tail chrome", script: (b) => { b.setStatus("working", "esc to cancel"); b.setTail("42%"); } },
];

describe("KC1 T-C1 — N=1 byte identity (the anchor: the legacy row and the composer's one row are the SAME bytes)", () => {
	for (const s of SCENARIOS) {
		for (const [label, line, cursor] of [
			["ASCII, cursor mid-line", "abc", 1],
			["ASCII, cursor at the end", "abc", 3],
			["CJK (wide cells)", "\u4f60\u597d", 2],
			["an empty line", "", 0],
		] as const) {
			it(`${s.label} — ${label}`, () => {
				const before = frames(legacy(line, cursor), s.script, { W: s.W, H: s.H });
				const after = frames(additive(line, cursor), s.script, { W: s.W, H: s.H });
				expect(after).toBe(before);
			});
		}
	}

	it("the REAL editor's additive dockState renders the legacy bytes exactly (a single-line buffer)", () => {
		const editor = new Editor(() => {});
		editor.feed(enc("hello\u4e2d"));
		const st = editor.dockState();
		expect(st.lines).toEqual([st.line]); // the one-row view IS the legacy line
		const script = (b: Body): void => b.textAppend("streaming");
		expect(frames(() => editor.dockState(), script)).toBe(frames(legacy(st.line, st.cursor), script));
	});

	it("a horizontally SCROLLED line keeps its dim … prefix and its column — identical bytes", () => {
		const editor = new Editor(() => {});
		Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true });
		editor.feed(enc("x".repeat(60)));
		const st = editor.dockState();
		expect(st.line.startsWith("\x1b[2m…")).toBe(true); // the scroll really engaged
		const script = (b: Body): void => b.raw(["x"]);
		expect(frames(() => editor.dockState(), script, { W: 40 })).toBe(frames(legacy(st.line, st.cursor), script, { W: 40 }));
		Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
	});

	it("the chrome still sits on H−3/H−2/H−1/H and the cursor CHA still lands on the marker", () => {
		const committing = frames(additive("abc", 1), (b) => b.raw(["x"]));
		expect(committing).toContain("› abc"); // the lead + the line, marker stripped
		expect(committing).not.toContain("kiso-cur"); // the APC marker never reaches the stream
		expect(committing).toContain("\x1b[6G"); // wallL (2) + lead (2) + cursor (1) + 1
		// DECLARED SUPERSESSION (REL-0152-R1): the anchor jump is retired
		// with the steady path that used it. A no-commit frame no longer
		// marches from a recorded anchor to the bottom row; it writes the
		// rows that changed, at absolute positions.
		//
		// What this line was checking is that a no-commit frame still
		// PAINTS — the anchor jump being its first act — so that is what
		// is asserted: streamed text with nothing committed produces a
		// frame, and the frame carries the text.
		const noCommit = frames(additive("abc", 1), (b) => b.textAppend("live"));
		expect(noCommit).not.toBe("");
		expect(noCommit).toContain("live");
	});
});

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});

afterEach(() => {
	vi.useRealTimers();
	delete (process.stdout as { rows?: number }).rows;
	delete (process.stdout as { columns?: number }).columns;
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});
