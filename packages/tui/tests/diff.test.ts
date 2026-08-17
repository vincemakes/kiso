/**
 * v2e — the diff renderer, unit-tested: edit_file's in-place search→
 * replace window, write_file's row-level LCS (new file = all +), the
 * 2-row context, the 40-line truncation, and the ± stats for the frozen
 * summary.
 */

import { describe, expect, it } from "vitest";
import { editFileDiff, truncateDiff, writeFileDiff } from "../src/diff.js";

describe("v2e: diff computation", () => {
	it("edit_file diffs the search→replace window IN PLACE with 2-row context", () => {
		const old = ["a", "b", "OLD", "c", "d"].join("\n");
		const r = editFileDiff(old, "OLD", "NEW");
		// The unchanged rows are CONTEXT (" " kind); only the window changes.
		expect(r.lines.map((l) => `${l.kind}${l.text}`)).toEqual([" a", " b", "-OLD", "+NEW", " c", " d"]);
		expect(r.added).toBe(1);
		expect(r.removed).toBe(1);
	});

	it("write_file on a NEW file is all +", () => {
		const r = writeFileDiff(null, "one\ntwo\nthree");
		expect(r.lines.map((l) => `${l.kind}${l.text}`)).toEqual(["+one", "+two", "+three"]);
		expect(r.added).toBe(3);
		expect(r.removed).toBe(0);
	});

	it("write_file diffs an EXISTING file row-level", () => {
		const old = ["one", "two", "three"].join("\n");
		const r = writeFileDiff(old, "one\ntwo\nTHREE");
		expect(r.added).toBe(1);
		expect(r.removed).toBe(1);
		const changed = r.lines.find((l) => l.kind === "+")!;
		expect(changed.text).toBe("THREE");
	});

	// MOVED (R1.5 slice ②, the approval-diff truth class — declared this
	// round): v2e's "degrades to the whole-file diff" IS the lie VD-2
	// filed. The tool errors on a miss and changes nothing, so the preview
	// says so instead of drawing a rewrite that will never happen.
	it("a missing search window is an honest note, never a fabricated whole-file diff", () => {
		const r = editFileDiff("one\ntwo", "absent", "x", "one.ts");
		expect(r.added + r.removed).toBe(0);
		expect(r.notFound).toBe(true);
		expect(r.lines.map((l) => l.text)).toEqual(["pattern not found in one.ts"]);
	});

	it("the 40-line cap truncates to 18 head + 18 tail + the /last hint", () => {
		const long = Array.from({ length: 60 }, (_, i) => `line ${i}`);
		const r = writeFileDiff(null, long.join("\n"));
		expect(r.lines.length).toBe(60); // the FULL diff stays for the stats
		const rendered = truncateDiff(r.lines);
		expect(rendered.length).toBe(37); // 18 + 1 hint + 18
		expect(rendered[0]!.text).toBe("line 0");
		expect(rendered[18]!.text).toBe("… 24 lines (/last for full)");
		expect(rendered[36]!.text).toBe("line 59");
	});

	it("the ± stats come from the FULL diff, not the truncated view", () => {
		const long = Array.from({ length: 50 }, (_, i) => `line ${i}`);
		const r = writeFileDiff(null, long.join("\n"));
		expect(r.added).toBe(50);
		expect(truncateDiff(r.lines).length).toBe(37);
	});
});
