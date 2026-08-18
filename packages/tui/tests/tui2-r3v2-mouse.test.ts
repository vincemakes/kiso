/**
 * TUI2-R3v2 slice ② — the mouse, and the invariant that makes it
 * shippable.
 *
 * A terminal left in mouse-reporting mode is a broken terminal: every
 * click and every scroll turns into escape bytes printed at the shell
 * prompt, and the user's only fix is `reset`. That failure is worse than
 * having no mouse support at all, so the enable is scoped as narrowly as
 * it can be — ON when a selection surface opens, OFF when it closes —
 * and the disable is emitted on EVERY path that can end the screen,
 * including the one where the previous process died without emitting
 * anything (enter() resets defensively, because a fresh process is the
 * only thing left that can clean up after a kill -9).
 *
 * The click itself is deliberately the smallest possible gesture: a
 * left-press on an option row is that row's digit. Not a drag, not a
 * release, not a wheel tick, and not a click anywhere else — every one
 * of those is ignored, because a panel that acts on ambiguous mouse
 * input is a panel that approves things nobody meant to approve.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";
import type { PanelVerdict, PanelView } from "../src/approval-panel.js";

const enc = (s: string) => new TextEncoder().encode(s);

/** SGR 1006: press / release of button `b` at 1-based col/row. */
const press = (col: number, row: number, b = 0) => enc(`\x1b[<${b};${col};${row}M`);
const release = (col: number, row: number, b = 0) => enc(`\x1b[<${b};${col};${row}m`);

export const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l";

const view: PanelView = {
	flavor: "approval",
	name: "shell",
	title: "shell rm -rf build",
	speaker: "mode:default",
	statusText: "▸ run paused",
	args: { kind: "text", lines: ["rm -rf build"] },
	fallbackQuestion: "approve shell? (y/n) ",
};

/** The editor with stdout captured — the mouse bytes are writes, and the
 *  whole invariant is about which writes happen when. */
function captured(): { editor: Editor; out: () => string; clear: () => void } {
	const writes: string[] = [];
	const real = process.stdout.write.bind(process.stdout);
	(process.stdout as unknown as { write: unknown }).write = (chunk: string | Uint8Array): boolean => {
		writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	};
	const editor = new Editor(() => {});
	(editor as unknown as { restoreStdout: () => void }).restoreStdout = () => {
		(process.stdout as unknown as { write: unknown }).write = real;
	};
	return { editor, out: () => writes.join(""), clear: () => (writes.length = 0) };
}

beforeEach(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	if (typeof (process.stdin as { setRawMode?: unknown }).setRawMode !== "function") {
		(process.stdin as unknown as { setRawMode: (b: boolean) => void }).setRawMode = () => {};
	}
});

describe("TUI2-R3v2 ② — the mouse never leaks", () => {
	it("enter() DEFENSIVELY disables mouse mode — a previous process may have died with a panel open", () => {
		const { editor, out } = captured();
		editor.enter();
		expect(out(), "enter() must reset ?1000/?1006 before anything else").toContain(MOUSE_OFF);
		editor.exit();
	});

	it("exit() disables it — the ordinary teardown path", () => {
		const { editor, out, clear } = captured();
		editor.enter();
		clear();
		editor.exit();
		expect(out()).toContain(MOUSE_OFF);
	});

	it("a panel OPENS mouse reporting and CLOSES it — never a byte wider than the surface", () => {
		const { editor, out, clear } = captured();
		editor.enter();
		clear();
		editor.beginPanel(view, () => {});
		expect(out(), "opening a selection surface enables SGR 1006").toContain(MOUSE_ON);
		clear();
		editor.feed(enc("\r")); // confirm — the panel closes
		expect(out(), "closing it disables SGR 1006").toContain(MOUSE_OFF);
		editor.exit();
	});

	it("a CANCELLED panel disables it too — every close is a close", () => {
		const { editor, out, clear } = captured();
		editor.enter();
		editor.beginPanel(view, () => {});
		clear();
		editor.cancelPanel();
		expect(out()).toContain(MOUSE_OFF);
		editor.exit();
	});

	it("exit() with a panel STILL OPEN disables it — the crash-exit path", () => {
		const { editor, out, clear } = captured();
		editor.enter();
		editor.beginPanel(view, () => {});
		clear();
		editor.exit();
		expect(out()).toContain(MOUSE_OFF);
	});
});

describe("TUI2-R3v2 ② — a click is a confirm", () => {
	/** The panel's rows are placed by the compositor; the editor asks it
	 *  where they are. The test binds a known layout so the hit-test is
	 *  the thing under test rather than the geometry. */
	function withRows(editor: Editor, top: number): void {
		editor.bindPanelRows(() => ({ top, count: 4 }));
	}

	it("a left-press on an option ROW confirms that option — the digit's equal", () => {
		const { editor } = captured();
		let verdict: PanelVerdict | null = null;
		editor.enter();
		editor.beginPanel(view, (v) => (verdict = v));
		withRows(editor, 10); // options occupy absolute rows 10..13
		editor.feed(press(5, 11)); // row 11 = option 2
		expect(verdict).toEqual({ action: "allow-rule", rule: "shell" });
		editor.exit();
	});

	it("the click lands on the row it was aimed at, for every row", () => {
		for (const [row, expected] of [
			[10, { action: "allow", reason: "" }],
			[11, { action: "allow-rule", rule: "shell" }],
		] as const) {
			const { editor } = captured();
			let verdict: PanelVerdict | null = null;
			editor.enter();
			editor.beginPanel(view, (v) => (verdict = v));
			withRows(editor, 10);
			editor.feed(press(3, row));
			expect(verdict, `row ${row}`).toEqual(expected);
			editor.exit();
		}
	});

	it("a click OUTSIDE the option rows is inert — the panel stays open, the cursor unmoved", () => {
		const { editor } = captured();
		let verdict: PanelVerdict | null = null;
		editor.enter();
		editor.beginPanel(view, (v) => (verdict = v));
		withRows(editor, 10);
		editor.feed(press(5, 9)); // the args, above the list
		editor.feed(press(5, 14)); // the affordance, below it
		expect(verdict).toBeNull();
		expect(editor.panelState()?.cursor).toBe(0);
		editor.exit();
	});

	it("the RELEASE is not a click — the press already answered", () => {
		const { editor } = captured();
		let verdict: PanelVerdict | null = null;
		editor.enter();
		editor.beginPanel(view, (v) => (verdict = v));
		withRows(editor, 10);
		editor.feed(release(5, 11)); // a release with no press before it
		expect(verdict).toBeNull();
		editor.exit();
	});

	it("the WHEEL and the DRAG are ignored — only a plain left press decides", () => {
		for (const button of [64, 65, 32, 34, 1, 2]) {
			const { editor } = captured();
			let verdict: PanelVerdict | null = null;
			editor.enter();
			editor.beginPanel(view, (v) => (verdict = v));
			withRows(editor, 10);
			editor.feed(press(5, 11, button));
			expect(verdict, `button ${button}`).toBeNull();
			editor.exit();
		}
	});

	it("the mouse bytes never reach the COMPOSER — not as text, not as a stuck CSI", () => {
		// the retired CSI parser matched [0-9;?]* and would have PARKED a
		// `<` sequence as an incomplete escape forever, swallowing every
		// keystroke after it. A panel-less editor must simply drop them.
		const { editor } = captured();
		editor.enter();
		editor.feed(press(5, 11));
		editor.feed(release(5, 11));
		editor.feed(enc("hello"));
		expect(editor.line()).toBe("hello");
		editor.exit();
	});
});
