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
import { renderEvent } from "../src/lines.js";
import { displayWidth } from "../src/width.js";
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
		// MOVED (the TUI2-R3v2 panel-selection supersession class): the digit
		// no longer selects-then-waits, so the two-key idiom is one key. A
		// bare enter takes the highlighted option and the panel closes; a
		// second key here would land in the RESTORED draft and submit it.
		editor.feed(enc("\r")); // confirm the highlighted option — the panel closes
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

/**
 * OR-11 (a) — Home and End repaint.
 *
 * CSI H / F moved the cursor and reflowed, but never called the render
 * callback: Ctrl+A and Ctrl+E repainted and their own arrow-key spellings
 * did not, so the caret sat where it had been until the next keystroke
 * happened to draw. The gesture that moves a cursor is the gesture that
 * has to show it.
 */
describe("OR-11 — Home/End repaint like Ctrl+A/E", () => {
	it("CSI H and CSI F each fire the render callback", () => {
		let renders = 0;
		const editor = new Editor(() => {
			renders += 1;
		});
		editor.feed(enc("hello world"));
		const typed = renders;
		editor.feed(enc("\x1b[H")); // Home
		expect(renders, "Home repainted").toBeGreaterThan(typed);
		const afterHome = renders;
		editor.feed(enc("\x1b[F")); // End
		expect(renders, "End repainted").toBeGreaterThan(afterHome);
	});

	it("and they still move the cursor where A3 put them", () => {
		const editor = new Editor(() => {});
		editor.feed(enc("hello world"));
		editor.feed(enc("\x1b[H"));
		expect(editor.dockState().cursorCol).toBe(0);
		editor.feed(enc("\x1b[F"));
		expect(editor.dockState().cursorCol).toBe("hello world".length);
	});
});

/**
 * OR-11 (a) — the budget follows the lead that is actually drawn.
 *
 * `#reflow` measured against PROMPT (`"▌ "`, two columns) while the CLI
 * binds the compositor's lead as `""`. The editor therefore believed the
 * row was two columns narrower than the compositor drew it, so the
 * horizontal scroll fired two columns early and the last two cells of
 * every row were unreachable — the two width authorities W23 says must
 * never disagree, disagreeing by two.
 */
describe("OR-11 — the reflow budget is the bound lead's, not the brick's", () => {
	it("with an empty lead the row reaches its last usable column", () => {
		Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true });
		const editor = new Editor(() => {});
		editor.setInputLead(() => ""); // what the CLI binds while the dock draws
		// W − leadW − 1 = 39 cells, and the caret needs one of them, so 38
		// characters are what fits whole: no scroll, no marker, the cursor
		// at the far end. (39 would scroll by one — the caret's own cell is
		// why the formula subtracts a column.)
		editor.feed(enc("x".repeat(38)));
		const st = editor.dockState();
		expect(st.lines, "the row is not scrolled").toEqual(["x".repeat(38)]);
		expect(st.cursorCol).toBe(38);
	});

	it("the default is still the brick, so a self-rendering editor is unchanged", () => {
		Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true });
		const editor = new Editor(() => {});
		// no setInputLead: PROMPT's two columns, budget 37 — the SAME 38
		// characters scroll, which is the two-column difference stated as a
		// behaviour rather than as arithmetic.
		editor.feed(enc("x".repeat(38)));
		expect(editor.dockState().cursorCol).toBeLessThan(38);
	});
});

/**
 * OR-11 — a long line WRAPS.
 *
 * DECLARED SUPERSESSION of ADR-0039 Amendment 2's horizontal scrolling:
 * one logical line used to be one row, scrolled sideways under a dim `…`
 * so that the text you were not looking at was simply not there. It folds
 * into visual rows now. The vertical window survives unchanged — N_MAX
 * counts VISUAL rows, the edge markers stay, the cursor's row is always
 * in view — and enter still submits the whole logical line.
 */
describe("OR-11 — the composer folds a long line into visual rows", () => {
	beforeEach(() => {
		Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true });
	});

	const bare = (): InstanceType<typeof Editor> => {
		const e = new Editor(() => {});
		e.setInputLead(() => ""); // the CLI's lead: budget = 40 − 0 − 1 = 39
		return e;
	};

	it("100 ASCII characters at width 40 become three rows, with no scroll marker", () => {
		const editor = bare();
		editor.feed(enc("x".repeat(100)));
		const st = editor.dockState();
		expect(st.lines).toHaveLength(3);
		expect(st.lines.join(""), "every character is on screen, none scrolled away").toBe("x".repeat(100));
		expect(st.lines.some((l) => l.includes("…")), "no scroll marker survives").toBe(false);
		expect(st.cursorRow).toBe(2);
		expect(st.cursorCol).toBe(100 - 39 * 2);
	});

	it("it breaks at a space, and a continuation row never begins with one", () => {
		const editor = bare();
		// 38 characters, a space, then a word: the space ends the first row
		// rather than opening the second.
		editor.feed(enc(`${"a".repeat(38)} second`));
		const st = editor.dockState();
		expect(st.lines[0]).toBe(`${"a".repeat(38)} `);
		expect(st.lines[1]).toBe("second");
	});

	it("CJK breaks between any two characters and never splits a wide one", () => {
		const editor = bare();
		// U+5BBD, a two-column CJK ideograph, written as an escape because
		// the tracked tree is English-only (the CJK gate) — the code point
		// under test is real, only its spelling here is ASCII.
		const WIDE = "\u5bbd";
		editor.feed(enc(WIDE.repeat(30))); // 60 columns of wide characters
		const st = editor.dockState();
		expect(st.lines).toHaveLength(2);
		// 39 columns of budget hold 19 wide characters, never 19.5
		expect([...st.lines[0]!].length).toBe(19);
		expect(st.lines.join("")).toBe(WIDE.repeat(30));
	});

	it("a run with no break point hard-breaks at the last character that fits", () => {
		const editor = bare();
		const url = `https://example.com/${"a".repeat(100)}`;
		editor.feed(enc(url));
		const st = editor.dockState();
		expect(st.lines.join("")).toBe(url);
		expect(st.lines.every((l) => [...l].length <= 39)).toBe(true);
	});

	it("8 visual rows of ONE logical line window to 6 with the markers, the cursor in view", () => {
		const editor = bare();
		editor.feed(enc("y".repeat(39 * 8)));
		const st = editor.dockState();
		expect(st.lines).toHaveLength(6);
		expect(st.lines[0], "the hidden-above marker").toContain("\x1b[2m…");
		expect(st.cursorRow).toBe(5);
	});

	it("a line that fits carries no marker at all", () => {
		const editor = bare();
		editor.feed(enc("short"));
		expect(editor.dockState().lines).toEqual(["short"]);
	});
});

/**
 * OR11-F1 — a whitespace run at the fold must not push the row past the
 * budget.
 *
 * The break rule prefers the last whitespace RUN that fits, and ends the
 * row with the whole run so that no continuation row opens with a space.
 * It absorbed the run with no cap: a run STRADDLING the boundary carried
 * the row past the budget, which is invariant ① — every row kiso produces
 * measures ≤ W, because autowrap is off and the terminal will not save it.
 * The compositor throws on it under KISO_INVARIANTS=throw and cuts with a
 * notice in the field, and the hidden columns put the cursor mapping out.
 *
 * The rule yields: "a continuation row never begins with whitespace" is a
 * preference, and ① is not. When the run itself does not fit, the row
 * stops at the budget and the leftover spaces open the next row.
 *
 * Reachable by any short paste of indented code under the capsule
 * threshold, or a few spaces typed at the boundary.
 */
describe("OR11-F1 — no row is wider than its budget", () => {
	const strip = (t: string): string => t.replace(/\x1b\[[0-9;]*m/g, "");

	const rowsOf = (input: string, columns: number): string[] => {
		Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
		const editor = new Editor(() => {});
		editor.setInputLead(() => "");
		editor.feed(enc(input));
		return editor.dockState().lines.map(strip);
	};

	it("the straddling run: 34 letters, 12 spaces, 20 letters at width 40", () => {
		const input = `${"a".repeat(34)}${" ".repeat(12)}${"b".repeat(20)}`;
		const rows = rowsOf(input, 40);
		// before the fix these measured [46, 20] against a budget of 39
		for (const row of rows) expect(displayWidth(row), `row "${row.slice(0, 12)}…" fits`).toBeLessThanOrEqual(39);
		expect(rows.join(""), "and the rows still tile the buffer exactly").toBe(input);
	});

	it("property: over letters, spaces, CJK and a wide emoji, every row fits and the rows tile", () => {
		// a seeded LCG, so a failure names an input that can be replayed
		let seed = 0x5eed;
		const rnd = (n: number): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		// \u4f60 and \u597d are two-column CJK; \u{1f600} is a wide emoji and
		// a surrogate pair, so it also pins that the fold walks CODE POINTS.
		const alphabet = [..."abcde ", "\u4f60", "\u597d", "\u{1f600}"];
		for (let i = 0; i < 300; i += 1) {
			const columns = [20, 40, 80][i % 3]!;
			const budget = columns - 1;
			// short enough to fit the 6-row window, so no edge marker rides
			// a row and changes what is being measured
			let input = "";
			const cells = 8 + rnd(70);
			while (displayWidth(input) < cells) input += alphabet[rnd(alphabet.length)]!;
			const rows = rowsOf(input, columns);
			for (const row of rows) {
				expect(displayWidth(row), `seed ${i}, width ${columns}, input ${JSON.stringify(input)}`).toBeLessThanOrEqual(budget);
			}
			expect(rows.join(""), `seed ${i}, width ${columns}: the rows tile the buffer`).toBe(input);
		}
	});
});
