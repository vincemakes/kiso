/**
 * R9 P2 — THE COMMAND SLAB, and the degradation that is the whole point
 * of having a predicate for it.
 *
 * §1.6 gives the wash to the machine's verbatim text, and a call's own
 * output is exactly that. The slab is the surface that says so: full-
 * width washed rows, the head row naming the call, the output inside,
 * the outcome closing it in words (§7.5).
 *
 * THE DEGRADATION IS SEPARATELY GATED, below, because getting it wrong
 * is not a cosmetic miss. `wash` is a chosen background on the two KNOWN
 * grounds and REVERSE VIDEO where none is known (§3's last rung). A one-row chip
 * inverting is the ladder working as designed; eight output rows
 * inverting is a black slab dropped into the middle of the transcript on
 * every terminal that never answered OSC 11. So the slab paints only
 * where the wash is a real background, and where it is not the block
 * falls back to what it has always been — R8a's four-column indent with
 * a dim tail — and never, on any path, to reverse video.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cellComponent, type BodyCell, type FrameCtx } from "../src/components.js";
import { COLOR_DARK, COLOR_LIGHT, setGround } from "../src/render.js";
import { visibleWidth } from "../src/components.js";

beforeAll(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => setGround("unknown"));

const CTX: FrameCtx = { spinnerI: 0, now: 10_000, height: 24 };
const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");

function shell(lines: number, over: Partial<Extract<BodyCell, { kind: "tool" }>> = {}): Extract<BodyCell, { kind: "tool" }> {
	return {
		kind: "tool",
		name: "shell",
		input: "pwd && ls -la",
		inputFull: JSON.stringify({ command: "pwd && ls -la" }),
		resultText: Array.from({ length: lines }, (_, i) => `row ${i + 1}`).join("\n"),
		state: "done",
		isError: false,
		added: 0,
		removed: 0,
		startedAt: 0,
		doneAt: 400,
		reason: null,
		verdict: null,
		expanded: false,
		diff: null,
		turn: 0,
	} as Extract<BodyCell, { kind: "tool" }>;
}
const render = (c: Extract<BodyCell, { kind: "tool" }>, W = 64): string[] => cellComponent(c).render(W, CTX);

// Graphite (design.md §2): a card's ground running and run — the machine's
// blue (owner, 2026-09-29) — as the palette writes it; the test environment
// runs in the 24-bit tier (tests/setup-env.ts).
const WASH = { light: COLOR_LIGHT.washRun, dark: COLOR_DARK.washRun } as const;

/** A painted card row's content after the edge cell and the mark cell. */
const inner = (r: string): string => plain(r).slice(2).trim();
/** A card's pad: a whole row of its ground with nothing on it (§1.5). */
const isPad = (r: string): boolean => (r.includes(WASH.light) || r.includes(WASH.dark)) && plain(r).trim() === "";

describe("R9 P2 → Graphite §7.4 — the card's shape", () => {
	// Re-derived for the card round (owner, 2026-10-05): the key stands at
	// the note's right margin, so the foot row is gone.
	it("pad, head with its outcome, the note with the key, five output rows, pad — the pads whole rows of ground (§1.5)", () => {
		setGround("light");
		const rows = render(shell(88));
		expect(rows).toHaveLength(9);
		expect(isPad(rows[0]!) && isPad(rows[8]!)).toBe(true);
		expect(inner(rows[1]!)).toMatch(/^SHELL pwd && ls -la +exit 0 · 88 lines · 0\.4s$/);
		expect(inner(rows[2]!)).toMatch(/^\u2026 83 earlier lines +ctrl\+o expands$/);
		expect(rows.slice(3, 8).map(inner)).toEqual(["row 84", "row 85", "row 86", "row 87", "row 88"]);
	});

	it("every row is EXACTLY the width — a card that stops short is not a card", () => {
		for (const g of ["light", "dark"] as const) {
			setGround(g);
			for (const W of [40, 64, 80, 120]) {
				for (const row of render(shell(88), W)) expect(visibleWidth(row), `${g} W=${W}`).toBe(W);
			}
		}
	});

	it("D4: a settled shell keeps its tail — the VD-5 collapse is reversed", () => {
		setGround("light");
		expect(render(shell(3)).map(inner)).toContain("row 3");
	});

	it("a short output is not cut: no note row and no foot", () => {
		setGround("light");
		const rows = render(shell(3));
		expect(rows.map(inner).join("\n")).not.toContain("earlier lines");
		expect(rows.filter((r) => !isPad(r)).map(inner)).toEqual([expect.stringMatching(/^SHELL pwd && ls -la +exit 0 · 3 lines · 0\.4s$/), "row 1", "row 2", "row 3"]);
	});

	/**
	 * DECLARED REVERSAL (R13, owner 2026-09-03) of the 2026-09-02 narrowing:
	 * the surface says WORK, not VERBATIM, so a bodiless call is a card too —
	 * its head between its pads. The degradation did not move: where no
	 * ground is known nothing paints, and the fallback is never reverse video.
	 */
	it("a call with NO output on screen is its head between its pads, and never reverse video", () => {
		const read = { ...shell(0), name: "read_file", input: "src/parser.ts", inputFull: JSON.stringify({ path: "src/parser.ts" }), resultText: "" };
		for (const g of ["light", "dark"] as const) {
			setGround(g);
			const rows = render(read as Extract<BodyCell, { kind: "tool" }>);
			expect(rows, `ground=${g}`).toHaveLength(3);
			expect(inner(rows[1]!), `ground=${g}`).toMatch(/^READ src\/parser\.ts +0 lines · 0\.4s$/);
			expect(rows[1], `ground=${g}`).toContain(g === "light" ? WASH.light : WASH.dark);
			for (const row of rows) expect(row, `ground=${g}`).not.toContain("\x1b[7m");
		}
		setGround("unknown");
		const flat = render(read as Extract<BodyCell, { kind: "tool" }>);
		expect(flat).toHaveLength(1);
		expect(flat[0]).not.toMatch(/\x1b\[(?:48|49|7|27)[;m]/);
	});

	it("…and its CONTENT is the same on every ground — only the surface is contingent", () => {
		const read = { ...shell(0), name: "read_file", input: "src/parser.ts", inputFull: JSON.stringify({ path: "src/parser.ts" }), resultText: "" };
		const norm = (r: string): string => r.replace(/\s+/g, " ").trim();
		setGround("unknown");
		const bare = render(read as Extract<BodyCell, { kind: "tool" }>).map((r) => norm(plain(r)));
		for (const g of ["light", "dark"] as const) {
			setGround(g);
			const said = render(read as Extract<BodyCell, { kind: "tool" }>).filter((r) => !isPad(r)).map((r) => norm(inner(r)));
			expect(said, `ground=${g}`).toEqual(bare);
		}
	});

	it("§1.3: no corner inside a card — the surface IS the container", () => {
		setGround("light");
		expect(render(shell(88)).join("")).not.toContain("\u2514");
	});

	it("the output rows are ink2, never dim — output is content, dim is metadata", () => {
		setGround("light");
		for (const row of render(shell(88)).slice(3, 8)) {
			expect(row).toContain(COLOR_LIGHT.ink2);
			expect(row).not.toContain(COLOR_LIGHT.dim);
		}
	});

	it("the note and its key are dim — kiso's words about the result, not the result", () => {
		for (const [g, P] of [
			["light", COLOR_LIGHT],
			["dark", COLOR_DARK],
		] as const) {
			setGround(g);
			const rows = render(shell(88));
			expect(rows[2], `${g}: the note row`).toContain(P.washDim);
			// one tone for the row: the key is inside the note's span
			expect(rows[2]!.slice(rows[2]!.indexOf(P.washDim)), `${g}: the key`).toMatch(/^[^\x1b]*\x1b\[[0-9;]*m[^\x1b]*ctrl\+o expands/);
		}
	});

	it("§7.5: the verb is dim, the target plain, and a failure colours only its outcome word", () => {
		setGround("light");
		const head = render(shell(88))[1]!;
		expect(head).toContain(`${COLOR_LIGHT.dim}SHELL`);
		expect(head, "the target is not bold").not.toContain("\x1b[1mpwd");
		const bad = render({ ...shell(9), isError: true, resultText: `exit 1: boom\n${Array.from({ length: 9 }, (_, i) => `err ${i}`).join("\n")}` })[1]!;
		const between = bad.slice(bad.indexOf("SHELL"), bad.indexOf(`${COLOR_LIGHT.red}exit 1`));
		expect(bad).toContain(`${COLOR_LIGHT.red}exit 1`);
		expect(between, "the target took the failure colour").not.toContain(COLOR_LIGHT.red);
	});
});

/**
 * THE DEGRADATION. Its own describe, because it is the case that decides
 * whether this surface may ship at all: on an unresolved ground a surface
 * would be reverse video, and a card that reached for it would invert
 * every one of its rows.
 */
describe("R9 P2 — with no ground, the card does not paint at all", () => {
	it("emits NO reverse video, at any width — the failure this gate exists for", () => {
		setGround("unknown");
		for (const W of [40, 64, 80, 120]) {
			const joined = render(shell(88), W).join("");
			expect(joined, `W=${W}`).not.toContain("\x1b[7m");
			expect(joined, `W=${W}`).not.toContain("\x1b[27m");
		}
	});

	it("emits no background of any kind", () => {
		setGround("unknown");
		expect(render(shell(88)).join("")).not.toMatch(/\x1b\[(?:48;|49m)/);
	});

	it("the head at the content edge, the body two columns under it opened by `└`, the key on the cut note", () => {
		setGround("unknown");
		const rows = render(shell(88)).map((r) => plain(r).trimEnd());
		expect(rows[0]).toMatch(/^ {2}SHELL pwd && ls -la +exit 0 · 88 lines · 0\.4s$/);
		expect(rows[1]).toMatch(/^ {2}\u2514 \u2026 83 earlier lines +ctrl\+o expands$/);
		expect(rows.slice(2)).toEqual(["    row 84", "    row 85", "    row 86", "    row 87", "    row 88"]);
		expect(render(shell(88))[2], "the output rows are dim off the card").toContain("\x1b[2m");
	});

	it("spends NO blank rows — an unpainted blank is §1.3's empty mark at row scale", () => {
		setGround("unknown");
		expect(render(shell(88)).map(plain).filter((r) => r.trim() === "")).toEqual([]);
	});

	it("the CONTENT is the same either way — only the surface is contingent", () => {
		const norm = (r: string): string => r.replace(/\s+/g, " ").trim();
		setGround("unknown");
		const flat = render(shell(88)).map((r) => norm(plain(r)).replace(/^\u2514 /, ""));
		setGround("light");
		const card = render(shell(88)).filter((r) => !isPad(r)).map((r) => norm(inner(r)));
		expect(card).toEqual(flat);
	});
});
