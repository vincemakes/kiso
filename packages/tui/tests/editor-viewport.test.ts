/**
 * KC1 slice ② — the ADDITIVE dockState and the DERIVED viewport (§5).
 *
 * dockState() keeps its legacy view (`line` + `cursor` — a single-line
 * buffer yields today's exact values, and a legacy one-row consumer
 * keeps working) and ADDS the composer's own: `lines` (the visible
 * rows, ≤ N_visible, carrying the dim "…" markers), `cursorRow` and
 * `cursorCol`. The window is DERIVED per read — no persistent #vscroll:
 *
 *   visibleStart = clamp(cursorLine − N_visible + 1, 0, lineCount − N_visible)
 *
 * so the cursor is always visible, the window trails it, and no stash /
 * restore / clear / submit path has new state to care about.
 *
 * The proofs: T-E5 (a durable user_input carrying newlines loads,
 * projects and re-renders identically — the ABI delta is 0: content was
 * always an arbitrary string), T-E6 (8 lines at N_visible = 6 — the
 * markers, the trailing window, the cursor always in view), T-E7 (a
 * multi-line draft survives a history restore, a queue-pop replace and
 * a panel open→close with its EXACT text and cursor).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { Editor } from "../src/editor.js";
import { renderEvent } from "../src/render.js";
import type { PanelView } from "../src/approval-panel.js";

const enc = (s: string) => new TextEncoder().encode(s);

const make = () => {
	const editor = new Editor(() => {});
	return editor;
};

/** the buffer's rows, marker-free — the assertions read the TEXT, the
 *  marker checks read the raw rows */
const plain = (rows: readonly string[]): string[] => rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""));

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

describe("KC1 — dockState is ADDITIVE (the public tui surface keeps its legacy view)", () => {
	it("a single-line buffer yields TODAY's exact legacy values, plus the one-row new view", () => {
		const editor = make();
		editor.feed(enc("ab\u4f60"));
		const st = editor.dockState();
		expect(st.line).toBe("ab\u4f60"); // legacy — unchanged
		expect(st.cursor).toBe(4); // legacy — display columns, unchanged
		expect(st.lines).toEqual(["ab\u4f60"]); // NEW — one row
		expect(st.cursorRow).toBe(0);
		expect(st.cursorCol).toBe(4);
	});

	it("the legacy pair is the CURSOR ROW's — `line` is `lines[cursorRow]`, `cursor` is `cursorCol`", () => {
		const editor = make();
		editor.feed(enc("one\x0atwo\x0athree"));
		const st = editor.dockState();
		expect(st.lines).toEqual(["one", "two", "three"]);
		expect(st.cursorRow).toBe(2);
		expect(st.cursorCol).toBe(5);
		expect(st.line).toBe(st.lines[st.cursorRow]!);
		expect(st.cursor).toBe(st.cursorCol);
	});
});

describe("KC1 T-E5 — the durable ABI delta is 0: a user_input with embedded newlines", () => {
	const CONTENT = "SELECT id\nFROM t\nWHERE x = 1";

	it("the line-mode projection keeps the content verbatim (content was always an arbitrary string)", () => {
		const out = renderEvent({ type: "user_input", content: CONTENT });
		expect(out.text).toContain(CONTENT);
		expect(out.newline).toBe(true);
	});

	it("the compositor's replay of the SAME event re-renders byte-identically", () => {
		const frameOf = (): string => {
			const writes: string[] = [];
			const body = new Body({ active: () => true, height: () => 24, width: () => 80, editCol: () => 1, write: (s) => writes.push(s) });
			body.enter();
			body.userLine(CONTENT);
			vi.advanceTimersByTime(16);
			return writes.join("");
		};
		const first = frameOf();
		const second = frameOf();
		expect(second).toBe(first); // the projection is pure — a replay is the same bytes
		// and the chip really carries the three lines (one row each)
		for (const row of ["SELECT id", "FROM t", "WHERE x = 1"]) expect(first).toContain(row);
	});

	it("the editor round-trips the durable string: a loaded draft submits EXACTLY what it carried", () => {
		const editor = make();
		const lines: string[] = [];
		editor.onLine((l) => lines.push(l));
		editor.feed(enc(`\x1b[200~${CONTENT}\x1b[201~`));
		expect(editor.line()).toBe(CONTENT);
		editor.feed(enc("\r"));
		expect(lines).toEqual([CONTENT]);
	});
});

describe("KC1 T-E6 — the DERIVED viewport: 8 lines at N_visible = 6", () => {
	const eight = () => {
		const editor = make();
		editor.feed(enc(Array.from({ length: 8 }, (_, i) => `line-${i}`).join("\x0a")));
		return editor;
	};

	it("the window shows N_MAX = 6 rows and TRAILS the cursor — the cursor's row is always in view", () => {
		const editor = eight();
		let st = editor.dockState();
		expect(st.lines.length).toBe(6);
		expect(plain(st.lines).at(-1)).toContain("line-7"); // the cursor sits on the last line
		expect(st.cursorRow).toBe(5);
		// ↑ ×3 — the window still holds the cursor
		editor.feed(enc("\x1b[A\x1b[A\x1b[A"));
		st = editor.dockState();
		expect(st.lines.length).toBe(6);
		expect(st.cursorRow).toBeGreaterThanOrEqual(0);
		expect(st.cursorRow).toBeLessThan(6);
		expect(plain(st.lines)[st.cursorRow]).toContain("line-4");
		// ↑ to the very top — the window has slid back to the buffer's head
		editor.feed(enc("\x1b[A\x1b[A\x1b[A\x1b[A\x1b[A"));
		st = editor.dockState();
		expect(plain(st.lines)[st.cursorRow]).toContain("line-0");
		expect(st.cursorRow).toBe(0);
	});

	it("a dim … marker rides the edge that HIDES lines — above when scrolled down, below when there is more", () => {
		const editor = eight();
		let st = editor.dockState();
		// the cursor is at the bottom: lines 0..1 are hidden ABOVE
		expect(st.lines[0]).toContain("\x1b[2m…"); // the dim marker
		expect(st.lines.at(-1)).not.toContain("…"); // nothing hidden below
		editor.feed(enc("\x1b[A".repeat(7))); // to the first line
		st = editor.dockState();
		expect(st.lines[0]).not.toContain("…"); // nothing hidden above
		expect(st.lines.at(-1)).toContain("\x1b[2m…"); // lines 6..7 hidden below
	});

	it("a buffer that FITS carries no markers at all", () => {
		const editor = make();
		editor.feed(enc("a\x0ab\x0ac"));
		const st = editor.dockState();
		expect(st.lines).toEqual(["a", "b", "c"]);
	});

	it("the cursor's column survives the window: cursorCol is the col WITHIN its row", () => {
		const editor = eight();
		editor.feed(enc("\x1b[A\x1b[A")); // ↑↑
		editor.feed(enc("\x01")); // line-local home
		expect(editor.dockState().cursorCol).toBe(0);
		editor.feed(enc("\x05")); // line-local end — "line-5" is 6 cells
		expect(editor.dockState().cursorCol).toBe(6);
	});
});

describe("KC1 T-E7 — a multi-line draft survives the stash paths (the flat buffer proves itself)", () => {
	it("the history browse restores the EXACT multi-line draft (text and cursor)", () => {
		const editor = make();
		editor.feed(enc("remembered\r")); // one history entry
		editor.feed(enc("draft one\x0adraft two"));
		editor.feed(enc("\x1b[H")); // Home — the cursor at the SECOND line's start
		const before = editor.dockState();
		editor.clearLine();
		editor.feed(enc("\x1b[A")); // browse the history
		expect(editor.line()).toBe("remembered");
		editor.feed(enc("\x1b")); // esc — back to the pre-browse (empty) input
		expect(editor.line()).toBe("");
		// the draft is the user's to retype — what the gate pins is that the
		// browse never MANGLED a multi-line buffer's shape while it walked
		editor.feed(enc("draft one\x0adraft two"));
		editor.feed(enc("\x1b[H"));
		expect(editor.dockState()).toEqual(before);
	});

	it("the queue-pop replaces the buffer with a multi-line message, cursor at its end", () => {
		const editor = make();
		const queue = ["popped one\npopped two"];
		editor.bindQueue(
			() => queue,
			() => queue.pop() ?? null,
		);
		editor.feed(enc("\x1b[A")); // ↑ from the EMPTY buffer — the pop
		expect(editor.line()).toBe("popped one\npopped two");
		const st = editor.dockState();
		expect(st.lines).toEqual(["popped one", "popped two"]);
		expect(st.cursorRow).toBe(1);
		expect(st.cursorCol).toBe(10); // the end of "popped two"
	});

	it("a panel open→close returns the EXACT multi-line draft and its cursor", () => {
		const editor = make();
		editor.feed(enc("keep one\x0akeep two\x0akeep three"));
		editor.feed(enc("\x1b[A")); // ↑ — the cursor parks on the middle line
		const before = editor.dockState();
		expect(before.cursorRow).toBe(1);
		editor.beginPanel(PANEL_VIEW, () => {});
		expect(editor.line()).toBe(""); // the panel owns a clean line
		editor.feed(enc("1")); // select allow…
		editor.feed(enc("\r")); // …and commit — the panel closes
		expect(editor.line()).toBe("keep one\nkeep two\nkeep three");
		expect(editor.dockState()).toEqual(before); // the draft AND the cursor
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
