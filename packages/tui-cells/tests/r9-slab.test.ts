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
 * grounds and REVERSE VIDEO on the third (§3 rung 4). A one-row chip
 * inverting is the ladder working as designed; eight output rows
 * inverting is a black slab dropped into the middle of the transcript on
 * every terminal that never answered OSC 11. So the slab paints only
 * where the wash is a real background, and where it is not the block
 * falls back to what it has always been — R8a's four-column indent with
 * a dim tail — and never, on any path, to reverse video.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cellComponent, type BodyCell, type FrameCtx } from "../src/components.js";
import { setGround } from "../src/render.js";
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
		rolled: null,
		verdict: null,
		expanded: false,
		diff: null,
		turn: 0,
	} as Extract<BodyCell, { kind: "tool" }>;
}
const render = (c: Extract<BodyCell, { kind: "tool" }>, W = 64): string[] => cellComponent(c).render(W, CTX);

const WASH = { light: "\x1b[48;5;255m", dark: "\x1b[48;5;236m" } as const;

describe("R9 P2 — the slab's shape", () => {
	it("head, blank, note, five output rows, blank, outcome", () => {
		setGround("light");
		const rows = render(shell(88)).map(plain);
		expect(rows).toHaveLength(10);
		expect(rows[0]!.trimEnd()).toBe("  shell pwd && ls -la");
		expect(rows[1]!.trim()).toBe("");
		expect(rows[2]!.trim()).toBe("… 83 earlier lines · ctrl+o expands");
		expect(rows.slice(3, 8).map((r) => r.trim())).toEqual(["row 84", "row 85", "row 86", "row 87", "row 88"]);
		expect(rows[8]!.trim()).toBe("");
		expect(rows[9]!.trim()).toBe("exit 0 · 88 lines · 0.4s");
	});

	it("every row is EXACTLY the width — a slab that stops short is not a slab", () => {
		for (const g of ["light", "dark"] as const) {
			setGround(g);
			for (const W of [40, 64, 80, 120]) {
				for (const row of render(shell(88), W)) {
					expect(visibleWidth(row), `${g} W=${W}`).toBe(W);
				}
			}
		}
	});

	it("D4: a settled shell keeps its tail — the VD-5 collapse is reversed", () => {
		setGround("light");
		expect(render(shell(3)).map(plain).map((r) => r.trim())).toContain("row 3");
	});

	it("a short output is not cut, and gets no note row", () => {
		setGround("light");
		const rows = render(shell(3)).map(plain).map((r) => r.trim());
		expect(rows.join("\n")).not.toContain("earlier lines");
		expect(rows.filter((r) => r !== "")).toEqual(["shell pwd && ls -la", "row 1", "row 2", "row 3", "exit 0 · 3 lines · 0.4s"]);
	});

	/**
	 * Owner ruling 2026-09-02, NARROWING R9's "one-row slab".
	 *
	 * R9 drew a bodiless call as a washed row too. §1.6 as it now stands
	 * gives the wash to the machine's VERBATIM text, and a row like
	 * `read loop.ts · 412 lines · 0.1s` is kiso's SUMMARY of a result —
	 * not one line of it. So the wash appears only where the call's own
	 * output does, and a call with nothing on screen is a plain row.
	 *
	 * Asserted on all three grounds, because the failure this forbids is
	 * a surface on a row with nothing verbatim on it, and that would be
	 * invisible on the ground where nothing paints anyway.
	 */
	it("a call with NO output on screen is a PLAIN row — no wash, and no reverse video either", () => {
		const read = { ...shell(0), name: "read_file", input: "src/parser.ts", inputFull: JSON.stringify({ path: "src/parser.ts" }), resultText: "" };
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			const rows = render(read as Extract<BodyCell, { kind: "tool" }>);
			expect(rows, `ground=${g}`).toHaveLength(1);
			expect(rows[0], `ground=${g}`).not.toContain(WASH.light);
			expect(rows[0], `ground=${g}`).not.toContain(WASH.dark);
			expect(rows[0], `ground=${g}`).not.toContain("\x1b[49m");
			expect(rows[0], `ground=${g}`).not.toContain("\x1b[7m");
		}
	});

	it("…and its CONTENT is untouched by the ruling — the same row on every ground", () => {
		const read = { ...shell(0), name: "read_file", input: "src/parser.ts", inputFull: JSON.stringify({ path: "src/parser.ts" }), resultText: "" };
		setGround("unknown");
		const bare = plain(render(read as Extract<BodyCell, { kind: "tool" }>)[0]!);
		expect(bare).toContain("read  src/parser.ts");
		expect(bare).toContain("0.4s");
		for (const g of ["light", "dark"] as const) {
			setGround(g);
			expect(plain(render(read as Extract<BodyCell, { kind: "tool" }>)[0]!), `ground=${g}`).toBe(bare);
		}
	});

	it("§1.3: no corner inside a slab — the surface IS the container", () => {
		setGround("light");
		expect(render(shell(88)).join("")).not.toContain("└");
	});

	it("§2.1: the output rows are body strength, never dim — dim on the wash is 3.91:1", () => {
		setGround("light");
		const rows = render(shell(88));
		// rows 3..7 are the output; none of them may open SGR 2 or the
		// ground's own dim index
		for (const row of rows.slice(3, 8)) {
			expect(row).not.toContain("\x1b[2m");
			expect(row).not.toContain("\x1b[38;5;243m");
		}
	});

	it("the note and the outcome take washDim, the grey chosen FOR the wash", () => {
		setGround("light");
		const rows = render(shell(88));
		expect(rows[2], "the note row").toContain("\x1b[38;5;241m");
		expect(rows[9], "the outcome row").toContain("\x1b[38;5;241m");
		setGround("dark");
		const dk = render(shell(88));
		expect(dk[2]).toContain("\x1b[38;5;247m");
		expect(dk[9]).toContain("\x1b[38;5;247m");
	});

	it("D6: the head row's target is BOLD, and a failure tints only the outcome", () => {
		setGround("light");
		expect(render(shell(88))[0]).toContain("\x1b[1m");
		const bad = render({ ...shell(9), isError: true, resultText: `exit 1: boom\n${Array.from({ length: 9 }, (_, i) => `err ${i}`).join("\n")}` });
		expect(bad[0], "the head row takes no tint").not.toContain("\x1b[38;5;124m");
		expect(bad.at(-1), "the outcome word does").toContain("\x1b[38;5;124m");
	});
});

/**
 * THE DEGRADATION. Its own describe, because it is the case that decides
 * whether this surface may ship at all: rung 4's wash IS `\x1b[7m`, and a
 * slab that reached for `p.wash` on an unresolved ground would invert
 * every one of its rows.
 */
describe("R9 P2 — with no ground, the slab does not paint at all", () => {
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
		const joined = render(shell(88)).join("");
		expect(joined).not.toContain(WASH.light);
		expect(joined).not.toContain(WASH.dark);
		expect(joined).not.toContain("\x1b[49m");
	});

	it("falls back to R8a's four-column indent with a dim tail, and keeps the corner", () => {
		setGround("unknown");
		const rows = render(shell(88));
		expect(rows.map(plain).map((r) => r.trimEnd())).toEqual([
			"  shell pwd && ls -la",
			"  └ … 83 earlier lines · ctrl+o expands",
			"    row 84",
			"    row 85",
			"    row 86",
			"    row 87",
			"    row 88",
			"    exit 0 · 88 lines · 0.4s",
		]);
		expect(rows[2], "the output rows are dim off the slab").toContain("\x1b[2m");
	});

	it("spends NO blank rows — an unpainted blank is §1.3's empty mark at row scale", () => {
		setGround("unknown");
		expect(render(shell(88)).map(plain).filter((r) => r.trim() === "")).toEqual([]);
	});

	it("the CONTENT shape is the same either way — only the surface is contingent", () => {
		setGround("unknown");
		const flat = render(shell(88)).map((r) => plain(r).trim());
		setGround("light");
		const slab = render(shell(88))
			.map((r) => plain(r).trim())
			.filter((r) => r !== "");
		expect(slab).toEqual(flat.map((r) => r.replace(/^└ /, "")));
	});
});
