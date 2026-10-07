/**
 * Graphite §6 (R2a) — an edit's or a write's card shows what it CHANGED,
 * drawn from the call's own input (never the file), so the card is the
 * same live, after a reprint and after resume; and a batch edit's
 * approval preview applies its hunks in order, as the tool does.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cellComponent, type BodyCell, type FrameCtx } from "../src/components.js";
import { editFileHunksDiff, hunksDiff, hunksOf, tokenMarks, wordTokens, type DiffLine } from "../src/diff.js";
import { COLOR_LIGHT, setGround } from "../src/render.js";
import { visibleWidth } from "../src/width.js";

beforeAll(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => setGround("unknown"));

const CTX: FrameCtx = { spinnerI: 0, now: 10_000, height: 40 };
const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
type ToolCell = Extract<BodyCell, { kind: "tool" }>;

function call(name: "edit_file" | "write_file", input: Record<string, unknown>, over: Partial<ToolCell> = {}): ToolCell {
	return {
		kind: "tool",
		name,
		input: JSON.stringify(input).slice(0, 60),
		inputFull: JSON.stringify(input, null, 2),
		childRoles: [],
		resultText: name === "edit_file" ? `edited ${String(input.path)}\n[rev:0123456789abcdef]` : `wrote ${String(input.path)} (9 chars)\n[rev:0123456789abcdef]`,
		state: "done",
		isError: false,
		added: 0,
		removed: 0,
		startedAt: 0,
		doneAt: 120,
		done: true,
		reason: null,
		verdict: null,
		expanded: false,
		diff: null,
		turn: 0,
		...over,
	} as ToolCell;
}
const render = (c: ToolCell, W = 80): string[] => cellComponent(c).render(W, CTX);
/** A painted card row's content after its edge and mark cells. */
const inner = (r: string): string => plain(r).slice(2).trimEnd();

const ONE = { path: "src/limits.ts", expectedRevision: "rev:1", search: "export const MAX = 3;\nconst keep = 1;", replace: "export const MAX = 5;\nconst keep = 1;" };

describe("the hunks a call carries", () => {
	it("the one pair, the batch, and nothing to draw", () => {
		expect(hunksOf({ search: "a", replace: "b" })).toEqual([{ search: "a", replace: "b" }]);
		expect(hunksOf({ edits: [{ search: "a", replace: "b" }, { search: "c", replace: "d" }] })).toHaveLength(2);
		expect(hunksOf({ edits: [] })).toBeNull();
		expect(hunksOf({ edits: [{ search: "a" }] })).toBeNull();
		expect(hunksOf({ path: "x" })).toBeNull();
	});

	it("a diff per hunk: the kept lines as context, `···` between hunks, the counts over all of them", () => {
		const d = hunksDiff([
			{ search: "a\nb\nc", replace: "a\nB\nc" },
			{ search: "x", replace: "y\nz" },
		]);
		expect(d.lines.map((l) => `${l.kind}${l.text}`)).toEqual([" a", "-b", "+B", " c", "note···", "-x", "+y", "+z"]);
		expect([d.added, d.removed]).toEqual([3, 2]);
	});
});

describe("word marks", () => {
	it("one line replaced by one line: exactly the words that changed", () => {
		const [a, b] = tokenMarks("export const MAX = 3;", "export const MAX = 5;");
		expect(a).toEqual([[19, 20]]);
		expect(b).toEqual([[19, 20]]);
		const d = hunksDiff([{ search: "export const MAX = 3;", replace: "export const MAX = 5;" }]);
		expect(d.lines.map((l) => l.marks)).toEqual([[[19, 20]], [[19, 20]]]);
	});

	it("no marks where the whole line changed, or where more than one line changed", () => {
		expect(tokenMarks("alpha beta gamma", "one two three")).toEqual([null, null]);
		const d = hunksDiff([{ search: "a = 1", replace: "a = 2\nb = 3" }]);
		expect(d.lines.every((l) => l.marks === undefined)).toBe(true);
	});

	it("property: marks are sorted, disjoint, on token boundaries, and the row strips back to its line", () => {
		let seed = 7;
		const rnd = (n: number): number => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			return seed % n;
		};
		const words = ["const", "let", "x", "y1", "=", "(", ")", "=>", "é", "\u6f22\u5b57", "🙂", "  ", "a_b", "42", ";"];
		const line = (): string => Array.from({ length: 1 + rnd(9) }, () => words[rnd(words.length)]).join(rnd(2) === 0 ? " " : "");
		setGround("light");
		for (let k = 0; k < 400; k += 1) {
			const a = line();
			const b = rnd(3) === 0 ? line() : a.replace(/\S+/, words[rnd(words.length)]!);
			const [ma, mb] = tokenMarks(a, b);
			for (const [text, marks] of [
				[a, ma],
				[b, mb],
			] as const) {
				if (marks === null) continue;
				const bounds = new Set([0]);
				let at = 0;
				for (const t of wordTokens(text)) bounds.add((at += t.length));
				let last = -1;
				for (const [s, e] of marks) {
					expect(s, `${text} ${JSON.stringify(marks)}`).toBeGreaterThan(last);
					expect(e).toBeGreaterThan(s);
					expect(bounds.has(s) && bounds.has(e), `a mark splits a token: ${text} ${JSON.stringify(marks)}`).toBe(true);
					last = e;
				}
			}
			// the rendered rows strip back to the lines, marks and all
			if (a === b) continue;
			const rows = render(call("edit_file", { path: "p", expectedRevision: "r", search: a, replace: b }), 200).map(inner);
			expect(rows.slice(2, 4), JSON.stringify([a, b])).toEqual([`- ${a}`.trimEnd(), `+ ${b}`.trimEnd()]);
		}
	});
});

describe("the card", () => {
	it("an edit: its head counts the change, its body is the diff on the add/del tints", () => {
		setGround("light");
		const rows = render(call("edit_file", ONE));
		expect(inner(rows[1]!)).toMatch(/^EDIT src\/limits\.ts +\+1 -1 · 0\.1s$/);
		expect(rows.slice(2, 5).map(inner)).toEqual(["- export const MAX = 3;", "+ export const MAX = 5;", "  const keep = 1;"]);
		expect(rows[2]).toContain(COLOR_LIGHT.del);
		expect(rows[3]).toContain(COLOR_LIGHT.add);
		// the changed word on the deeper tint, on both sides
		expect(rows[2]).toContain(`${COLOR_LIGHT.delWord}3${COLOR_LIGHT.del}`);
		expect(rows[3]).toContain(`${COLOR_LIGHT.addWord}5${COLOR_LIGHT.add}`);
		// the receipt (`edited …` and its revision) is not the body
		expect(rows.map(plain).join("\n")).not.toContain("rev:");
	});

	it("a batch: `N hunks` on the head, `···` between them", () => {
		setGround("light");
		const rows = render(call("edit_file", { path: "a.ts", expectedRevision: "r", edits: [{ search: "one", replace: "ONE" }, { search: "two", replace: "TWO" }] }));
		expect(inner(rows[1]!)).toMatch(/\+2 -2 · 2 hunks · 0\.1s$/);
		expect(rows.map(inner)).toContain("···");
	});

	// Re-derived for the card round (owner, 2026-10-05): the key stands at
	// the count's row's right margin, and the foot row is gone.
	it("a long diff: twelve rows, the count of the rest with the key beside it; expanded, all of it", () => {
		setGround("light");
		const search = Array.from({ length: 20 }, (_, i) => `old ${i}`).join("\n");
		const replace = Array.from({ length: 20 }, (_, i) => `new ${i}`).join("\n");
		const c = call("edit_file", { path: "big.ts", expectedRevision: "r", search, replace });
		const rows = render(c);
		expect(rows.slice(2, 14).every((r) => /^[-+] /.test(inner(r)))).toBe(true);
		expect(inner(rows[14]!)).toMatch(/^… 28 more lines +ctrl\+o expands$/);
		expect(rows).toHaveLength(16); // pad · head · 12 rows · the note · pad
		const all = render({ ...c, expanded: true });
		expect(all.filter((r) => /^[-+] /.test(inner(r)))).toHaveLength(40);
	});

	it("a write that creates its file: `new file · N lines`, its first five lines as additions", () => {
		setGround("light");
		const rows = render(call("write_file", { path: "n.md", expectedRevision: "absent", content: "1\n2\n3\n4\n5\n6\n7\n" }));
		expect(inner(rows[1]!)).toMatch(/^WRITE n\.md +new file · 7 lines · 0\.1s$/);
		expect(rows.slice(2, 7).map(inner)).toEqual(["+ 1", "+ 2", "+ 3", "+ 4", "+ 5"]);
		expect(inner(rows[7]!)).toMatch(/^… 2 more lines +ctrl\+o expands$/);
	});

	it("a write over a file: `rewrote · N lines`, its lines as they now read — not as additions (the old text is not in the log)", () => {
		setGround("light");
		const rows = render(call("write_file", { path: "o.md", expectedRevision: "rev:9", content: "a\nb\n" }));
		expect(inner(rows[1]!)).toMatch(/rewrote · 2 lines · 0\.1s$/);
		expect(rows.slice(2, 4).map(inner)).toEqual(["  a", "  b"]);
		expect(rows.join("")).not.toContain(COLOR_LIGHT.add);
	});

	it("a refused, denied or failed edit shows no diff — nothing changed", () => {
		setGround("light");
		const failed = render(call("edit_file", ONE, { isError: true, resultText: "edit_file: pattern not found in src/limits.ts" })).map(inner);
		expect(failed.join("\n")).not.toContain("- export const MAX");
		const denied = render(call("edit_file", ONE, { reason: "not now", verdict: { decision: "denied" } as never })).map(inner);
		expect(denied.join("\n")).not.toContain("- export const MAX");
	});

	it("running and run show the same body: the settle moves nothing", () => {
		setGround("light");
		const done = render(call("edit_file", ONE));
		const running = render(call("edit_file", ONE, { state: "running", doneAt: null, done: false }));
		expect(running.length).toBe(done.length);
		expect(running.slice(2, -1).map(inner)).toEqual(done.slice(2, -1).map(inner));
	});

	it("the card is a function of the call: a second cell built from the same input renders the same rows (live == reprint == resume)", () => {
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (const W of [20, 37, 80, 200]) expect(render(call("edit_file", ONE), W)).toEqual(render(call("edit_file", ONE), W));
		}
	});

	it("invariant ①: every row fits, W 20..200, on both grounds and the unknown one", () => {
		const big = { path: "p.ts", expectedRevision: "r", search: `const a = "${"x".repeat(150)}";\nkeep`, replace: `const a = "${"y".repeat(150)}";\nkeep` };
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (let W = 20; W <= 200; W += 1) {
				for (const c of [call("edit_file", big), call("edit_file", big, { expanded: true }), call("write_file", { path: "w", expectedRevision: "absent", content: "z".repeat(300) })]) {
					for (const r of render(c, W)) expect(visibleWidth(r), `${g} W=${W}: ${plain(r)}`).toBeLessThanOrEqual(W);
				}
			}
		}
	});

	it("off a painted card the diff keeps its flat form: marker and text in the line's colour", () => {
		setGround("unknown");
		const rows = render(call("edit_file", ONE)).map(plain);
		expect(rows.some((r) => /^\s*(└ )?- export const MAX = 3;$/.test(r))).toBe(true);
		expect(rows.some((r) => /^\s*\+ export const MAX = 5;$/.test(r))).toBe(true);
	});
});

describe("the approval preview of a batch (red: the panel read only search/replace)", () => {
	const file = "alpha\nbeta\ngamma\n";
	it("the hunks apply in order, each to what the ones before it left", () => {
		const d = editFileHunksDiff(file, [
			{ search: "alpha", replace: "ALPHA" },
			{ search: "ALPHA\nbeta", replace: "ALPHA\nBETA" },
		]);
		expect(d.outcome).toBe("diff");
		const changed = d.lines.filter((l: DiffLine) => l.kind !== " ").map((l) => `${l.kind}${l.text}`);
		expect(changed).toEqual(["-alpha", "-beta", "+ALPHA", "+BETA"]);
	});

	it("a hunk the tool would refuse is named, and nothing is drawn", () => {
		const miss = editFileHunksDiff(file, [{ search: "alpha", replace: "x" }, { search: "nope", replace: "y" }], "f.txt");
		expect(miss.outcome).toBe("not-found");
		expect(miss.lines).toEqual([{ kind: "note", text: "pattern not found in f.txt (hunk 2, after hunk 1 applied)" }]);
		const twice = editFileHunksDiff("one\ntwo two\n", [{ search: "one", replace: "1" }, { search: "two", replace: "2" }], "f.txt");
		expect(twice.outcome).toBe("ambiguous");
		expect(twice.lines).toEqual([{ kind: "note", text: "pattern matches more than one place in f.txt (hunk 2, after hunk 1 applied)" }]);
	});
});
