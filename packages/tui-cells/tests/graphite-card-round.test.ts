/**
 * Graphite, the card round (owner, 2026-10-05) — what reads inside a card.
 *
 *   1. The running `●` and the waiting `❯` stand in front of the outcome's
 *      words, where the settled outcome will stand; column 1 is blank, so
 *      nothing sits against the verb. Off the surface the mark keeps its
 *      own column, with a space after it.
 *   2. A shell command is never cut in its middle: it folds at its spaces,
 *      its rows hanging under its own first character, for at most three
 *      rows (the third ends in `…`); expanded, all of it. A path is one
 *      row and elides in its middle, as before.
 *   3. The cut note and the key share one row — what was cut at the left,
 *      the key at the right margin — and the collapsed card has no foot.
 *   4. A wrapped output line continues two cells in.
 *   5. A shell's tail never opens on a blank row, and keeps its height.
 *
 * The fold is measured against a fixed room for the outcome, so a card
 * neither re-folds while it runs nor changes height when it settles
 * (DC-46): gated here as a property over command lengths and widths.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cellComponent, type BodyCell, type FrameCtx } from "../src/components.js";
import { COLOR_LIGHT, setGround } from "../src/render.js";
import { visibleWidth } from "../src/width.js";

beforeAll(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => setGround("unknown"));

const CTX: FrameCtx = { spinnerI: 0, now: 10_000, height: 24 };
const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
/** A painted card row's content after the edge cell and column 1. */
const inner = (r: string): string => plain(r).slice(2).trimEnd();
const lines = (n: number, f: (i: number) => string): string => Array.from({ length: n }, (_, i) => f(i)).join("\n");

const LONG = "pwd; ls -la; echo ---; command -v node; node --version 2>&1 | head -5";
const tool = (over: Partial<Extract<BodyCell, { kind: "tool" }>> & { command?: string } = {}): Extract<BodyCell, { kind: "tool" }> => {
	const command = over.command ?? "npm test";
	return {
		kind: "tool",
		state: "done",
		isError: false,
		added: 0,
		removed: 0,
		startedAt: 0,
		doneAt: 1_000,
		done: true,
		reason: null,
		verdict: null,
		expanded: false,
		diff: null,
		turn: 0,
		childRoles: [],
		name: "shell",
		input: JSON.stringify({ command }).slice(0, 60),
		inputFull: JSON.stringify({ command }),
		resultText: "",
		...over,
	} as Extract<BodyCell, { kind: "tool" }>;
};
const running = (over: Partial<Extract<BodyCell, { kind: "tool" }>> & { command?: string } = {}) => tool({ state: "running", doneAt: null, done: false, startedAt: 9_000, ...over });
const render = (c: BodyCell, W = 80): string[] => cellComponent(c).render(W, CTX);
/** The head's rows: the first painted row after the pad, and every row
 *  after it that hangs (starts with spaces under the verb). */
const headOf = (rows: string[]): string[] => {
	const out = [inner(rows[1]!)];
	for (const r of rows.slice(2)) {
		if (!/^ {6}\S/.test(inner(r))) break;
		out.push(inner(r));
	}
	return out;
};

describe("1 — the mark stands in front of the outcome", () => {
	it("running: column 1 is blank and the breath leads the outcome's words", () => {
		setGround("light");
		const head = render(running())[1]!;
		expect(plain(head).slice(1, 2)).toBe(" ");
		expect(inner(head)).toMatch(/^SHELL npm test +● running · 1s · esc stops · alt\+⏎ redirects$/);
	});

	it("waiting: `❯ needs you`, both in gold, on the gold ground", () => {
		setGround("light");
		const head = render(tool({ state: "approval", doneAt: null, done: false, command: "rm -rf build && npm run build" }))[1]!;
		expect(plain(head).slice(1, 2)).toBe(" ");
		expect(inner(head)).toMatch(/^SHELL rm -rf build && npm run build +❯ needs you$/);
		expect(head).toContain(`${COLOR_LIGHT.gold}❯`);
		expect(head).toContain(`${COLOR_LIGHT.gold}needs you`);
		expect(head).toContain(COLOR_LIGHT.washAsk);
	});

	it("settled: no mark at all (§4.2)", () => {
		setGround("light");
		const head = inner(render(tool({ resultText: "ok" }))[1]!);
		expect(head).toMatch(/^SHELL npm test +exit 0 · 1 line · 1\.0s$/);
		expect(head).not.toMatch(/[●❯]/);
	});

	it("a settled card reserves no cells for a mark: the head keeps its count wherever the words fit", () => {
		setGround("light");
		// the widest outcome that fits beside the folded command's first row,
		// to the cell: a phantom mark would squeeze the count out
		const rows = render(tool({ command: "pwd; ls -la; echo ---; command -v node; node --version 2>&1 | head -5", resultText: lines(98, (i) => `x${i}`) }));
		expect(inner(rows[1]!)).toMatch(/^SHELL pwd; ls -la; echo ---; command -v node; node +exit 0 · 98 lines · 1\.0s$/);
		for (const r of [render(tool({ resultText: "ok" }))[1]!, render(running())[1]!]) expect(plain(r).trimEnd().length, plain(r)).toBe(79);
	});

	it("off the surface the mark keeps its own column, with a space after it", () => {
		setGround("unknown");
		expect(plain(render(running())[0]!)).toMatch(/^● SHELL npm test +running · 1s/);
	});
});

describe("2 — a command folds whole; a path does not", () => {
	it("the screenshot's command: whole, under itself, the outcome on the first row", () => {
		setGround("light");
		const rows = render(tool({ command: LONG, resultText: "ok" }));
		const head = headOf(rows);
		expect(head.length).toBe(2);
		expect(head[0]).toMatch(/ {2,}exit 0 · 1 line · 1\.0s$/);
		const words = head.map((r, i) => (i === 0 ? r.replace(/^SHELL /, "").replace(/ {2,}exit 0.*$/, "") : r.trim()));
		expect(words.join(" ")).toBe(LONG);
		expect(head.join("\n")).not.toContain("…");
		// the continuation hangs under the command's first character
		expect(head[1]!.match(/^ */)![0].length).toBe("SHELL ".length);
	});

	it("past three rows the third ends in `…`; expanded, all of it", () => {
		setGround("light");
		const command = Array.from({ length: 30 }, (_, i) => `step-${i}`).join(" && ");
		const head = headOf(render(tool({ command, resultText: "ok" })));
		expect(head.length).toBe(3);
		expect(head[2]!.endsWith("…")).toBe(true);
		const whole = headOf(render(tool({ command, resultText: "ok", expanded: true })));
		expect(whole.length).toBeGreaterThan(3);
		expect(whole.map((r, i) => (i === 0 ? r.replace(/^SHELL /, "").replace(/ {2,}exit 0.*$/, "") : r.trim())).join(" ")).toBe(command);
	});

	it("a path is one row and elides in its middle", () => {
		setGround("light");
		const path = "packages/runtime/src/deeply/nested/directory/structure/recovery-plan.ts";
		const rows = render(tool({ name: "read_file", input: path, inputFull: JSON.stringify({ path }), resultText: "x" }), 60);
		expect(inner(rows[1]!)).toMatch(/packages\/\S*…\S*\.ts/);
		expect(rows).toHaveLength(3);
	});

	it("THE FOLD NEVER MOVES WITH THE OUTCOME — running and settled heads are the same height, at every length and width", () => {
		for (const g of ["light", "unknown"] as const) {
			setGround(g);
			for (const W of [40, 60, 80, 100, 120]) {
				for (let n = 1; n <= 160; n += 3) {
					const command = Array.from({ length: n }, (_, i) => "abcdefgh"[i % 8]).join("").replace(/(.{5})/g, "$1 ");
					const live = render(running({ command, startedAt: 10_000 - 3_599_000 }), W).length;
					const settled = render(tool({ command, doneAt: 3_599_000 }), W).length;
					expect(settled, `${g} W=${W} n=${n}: the settle changed the head`).toBe(live);
				}
			}
		}
	});
});

describe("3 — the cut note and the key share one row", () => {
	it("a settled shell: the note opens the tail, the key at its right margin, no foot", () => {
		setGround("light");
		const rows = render(tool({ resultText: lines(90, (i) => `out ${i + 1}`) }));
		expect(inner(rows[2]!)).toMatch(/^… 85 earlier lines +ctrl\+o expands$/);
		expect(visibleWidth(rows[2]!)).toBe(80);
		expect(plain(rows.join("\n")).match(/ctrl\+o/g)).toHaveLength(1);
		expect(inner(rows.at(-2)!)).toBe("out 90");
	});

	it("a head preview: the note closes it, with the key", () => {
		setGround("light");
		const rows = render(tool({ name: "list_dir", input: "{}", inputFull: "{}", resultText: lines(89, (i) => `dir  d${i}/`) }));
		expect(inner(rows.at(-2)!)).toMatch(/^… 84 more lines +ctrl\+o expands$/);
	});

	it("a running card's note has no key, and the settle swaps words in place", () => {
		setGround("light");
		const live = render(running({ resultText: lines(90, (i) => `out ${i + 1}`) }));
		expect(inner(live[2]!)).toBe("… 85 earlier lines");
		expect(render(tool({ resultText: lines(90, (i) => `out ${i + 1}`) }))).toHaveLength(live.length);
	});

	it("expanded: no note, and the way back is the foot", () => {
		setGround("light");
		const rows = render(tool({ resultText: lines(9, (i) => `out ${i + 1}`), expanded: true }));
		expect(rows.map(inner).join("\n")).not.toContain("earlier");
		expect(inner(rows.at(-2)!).trim()).toBe("ctrl+o collapses");
	});

	it("narrow: the count's words give way first, then the key shortens; the count stays", () => {
		setGround("light");
		const at = (W: number): string => inner(render(tool({ resultText: lines(90, (i) => `out ${i}`) }), W)[2]!);
		expect(at(40)).toMatch(/^… 85 earlier lines +ctrl\+o expands$/);
		expect(at(28)).toMatch(/^… 85 +ctrl\+o expands$/);
		expect(at(16)).toMatch(/^… 85 +ctrl\+o$/);
		expect(at(10)).toMatch(/^… 85/);
	});
});

describe("4 — a wrapped output line continues two cells in", () => {
	it("the continuation hangs, and the line is whole across its rows", () => {
		setGround("light");
		const line = "drwxr-xr-x   17 dev  staff     544  Jul  4 10:17 release-evidence-2026-07-03-golden";
		const rows = render(tool({ resultText: `${line}\n---` }), 60).map(inner);
		const at = rows.indexOf(rows.find((r) => r.startsWith("drwxr"))!);
		expect(rows[at + 1]!.startsWith("  ")).toBe(true);
		expect(rows[at + 1]![2]).not.toBe(" ");
		expect(rows[at]! + rows[at + 1]!.slice(2)).toBe(line);
		expect(rows[at + 2]).toBe("---");
	});

	it("off the surface the continuation hangs under the body's own indent", () => {
		setGround("unknown");
		const line = "x".repeat(100);
		const rows = render(tool({ resultText: line }), 60).map(plain);
		expect(rows[1]).toMatch(/^ {2}└ x+$/);
		expect(rows[2]).toMatch(/^ {6}x+$/);
	});
});

describe("5 — a shell's tail never opens on a blank row", () => {
	const NPM = ["npm warn deprecated inflight@1.0.6", "npm warn deprecated glob@7.2.3", "", "added 14 packages in 2m", "", "9 packages are looking for funding", "  run `npm fund` for details"].join("\n");

	it("the blank gives way and the window reaches up — five rows, the count honest", () => {
		setGround("light");
		const rows = render(tool({ resultText: NPM })).map(inner);
		expect(rows[2]).toMatch(/^… 2 earlier lines +ctrl\+o expands$/);
		expect(rows.slice(3, 8)).toEqual(["npm warn deprecated glob@7.2.3", "added 14 packages in 2m", "", "9 packages are looking for funding", "  run `npm fund` for details"]);
	});

	it("the screenshot's install: never opens in the middle of a wrapped line either", () => {
		setGround("light");
		const long = ["npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory.", "npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported", "", "added 14 packages, removed 25 packages, and changed 107 packages in 2m", "", "9 packages are looking for funding", "  run `npm fund` for details"].join("\n");
		const rows = render(tool({ resultText: long })).map(inner);
		// the window starts at the second warning's first row; the two blank
		// rows give way to make its room, and the height is the same five
		expect(rows.slice(3, 8)).toEqual(["npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer suppo", "  rted", "added 14 packages, removed 25 packages, and changed 107 packages in 2m", "9 packages are looking for funding", "  run `npm fund` for details"]);
		// RE-DERIVED (0.47.1, finding 0470-F1): the note counts output LINES.
		// Hidden are the first warning (two rows, one line) and the two
		// blanks — three lines; it said 4, the rows.
		expect(rows[2]).toMatch(/^\u2026 3 earlier lines +ctrl\+o expands$/);
		const live = render(running({ resultText: long })).map(inner);
		expect(live.slice(3)).toEqual(rows.slice(3));
	});

	it("a long output with no blank to give way keeps the plain tail", () => {
		setGround("light");
		const rows = render(tool({ resultText: lines(20, () => "z".repeat(150)) })).map(inner);
		expect(rows.slice(3, 8)).toHaveLength(5);
		expect(rows[3]!.startsWith("  z")).toBe(true); // a continuation: nothing could give way
	});

	it("running, the same window: the settle moves nothing", () => {
		setGround("light");
		const live = render(running({ resultText: NPM })).map(inner);
		const settled = render(tool({ resultText: NPM })).map(inner);
		expect(live.length).toBe(settled.length);
		expect(live.slice(3)).toEqual(settled.slice(3));
	});

	it("when only blanks are cut, the window is left as it was", () => {
		setGround("light");
		const rows = render(tool({ resultText: ["a", "", "b", "c", "d", "e"].join("\n") })).map(inner);
		expect(rows[2]).toMatch(/^… 1 earlier line +ctrl\+o expands$/);
		expect(rows.slice(3, 8)).toEqual(["", "b", "c", "d", "e"]);
	});
});

describe("every row fits, on every ground", () => {
	it("W 20..160: no row wider than the terminal, no bare ESC", () => {
		const cells = [tool({ command: LONG, resultText: lines(40, (i) => `row ${i} ${"y".repeat(i * 3)}`) }), running({ command: LONG, resultText: lines(9, (i) => `r${i}`) }), tool({ state: "approval", doneAt: null, done: false, command: LONG })];
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (let W = 20; W <= 160; W += 1) {
				for (const c of cells) {
					for (const r of render(c, W)) {
						expect(visibleWidth(r), `${g} W=${W}: ${plain(r)}`).toBeLessThanOrEqual(W);
						expect(r.replace(/\x1b\[[0-9;]*m/g, ""), `${g} W=${W}: a bare ESC`).not.toContain("\x1b");
					}
				}
			}
		}
	});
});
