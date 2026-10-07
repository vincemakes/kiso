/**
 * The row seam (0.40.0) — one composer for every status row, and ZERO
 * behaviour change.
 *
 * The seam moved three hand-built rows onto one `composeRow`, so the
 * features of the launch build (a retry state, a mode and floor
 * indicator, a compaction progress bar) add a typed SEGMENT instead of
 * splicing a template — and the question of what gives way first at 80
 * columns is answered once instead of three times.
 *
 * "Zero behaviour change" is a claim, so it is proven differentially: the
 * PRE-SEAM implementations are kept below verbatim as the oracle, and the
 * new ones must reproduce them byte for byte across a grid of tiers,
 * model ids of every length (including the wide-character case the
 * DF-0330-F1 elision exists for), meters, and widths from generous down
 * to too narrow for anything. The existing row tests passed unchanged
 * too; this is the stronger form, because it does not depend on which
 * inputs someone thought to write down.
 *
 * RE-DERIVED (the legacy rows retired, owner 2026-10-06): the idle and
 * running rows the oracle compared are gone — the CLI draws the bar
 * (§8.9) and the live row (§8.7). Their grid cases went with them; the
 * compacting row, the composer's drop order and the floor rule (now on
 * the bar) stay.
 */

import { describe, expect, it } from "vitest";
import { displayWidth } from "@vincemakes/kiso-tui-cells/width";
import { kUnit } from "../src/lines.js";
import { compactingStatus, composeRow, statusBar, type BarInput } from "../src/status.js";

// ── The oracle: the pre-seam implementations, verbatim ──────────────────

function elideMiddle(text: string, max: number): string {
	if (displayWidth(text) <= max) return text;
	const chars = [...text];
	const room = max - 1;
	const headBudget = Math.ceil(room / 2);
	let head = "";
	for (const c of chars) {
		if (displayWidth(head + c) > headBudget) break;
		head += c;
	}
	let tail = "";
	const tailBudget = room - displayWidth(head);
	for (let i = chars.length - 1; i >= 0; i -= 1) {
		if (displayWidth(chars[i]! + tail) > tailBudget) break;
		tail = chars[i]! + tail;
	}
	return `${head}…${tail}`;
}

// RE-DERIVED (the compaction round, owner 2026-10-06): one round is
// `1 round` — the template said `1 rounds`; every other byte is unchanged
const oldCompacting = (glyph: string, rounds: number, tokens: number, elapsed: number): string =>
	`${glyph} compacting · ${rounds} round${rounds === 1 ? "" : "s"} · ~${kUnit(tokens)} tokens · ${Math.max(0, elapsed)}s`;

describe("the seam changes nothing — the new rows equal the old ones, byte for byte", () => {
	it("the compacting row, which used to be a template inline in dispatch", () => {
		for (const [rounds, tokens, s] of [[6, 95_100, 19], [1, 0, 0], [40, 1_200_000, 312], [5, 4_300, -3]] as const) {
			expect(compactingStatus("▘", rounds, tokens, s)).toBe(oldCompacting("▘", rounds, tokens, s));
		}
	});
});

describe("the drop order — decided once, for every row", () => {
	const segs = [
		{ kind: "hint" as const, text: "first hint" },
		{ kind: "label" as const, text: "a-label-that-is-considerably-longer-than-twenty-columns" },
		{ kind: "fact" as const, text: "FACT-A" },
		{ kind: "hint" as const, text: "last hint" },
		{ kind: "fact" as const, text: "FACT-B" },
	];

	it("with room, everything, in order", () => {
		expect(composeRow("HEAD", segs, 500)).toBe(["HEAD", ...segs.map((x) => x.text)].join(" · "));
	});

	it("labels are elided BEFORE any hint is dropped", () => {
		const full = composeRow("HEAD", segs);
		const W = displayWidth(full) - 5; // over by a little: eliding alone must be enough
		const row = composeRow("HEAD", segs, W);
		expect(row).toContain("first hint");
		expect(row).toContain("last hint");
		expect(row).toContain("…");
		expect(displayWidth(row)).toBeLessThanOrEqual(W);
	});

	it("hints go from the END, one at a time — the most useful gesture is taught longest", () => {
		// The width of exactly: label elided AND the last hint gone. At that
		// budget the first hint must survive, because hints drop from the end.
		const expected = ["HEAD", "first hint", elideMiddle(segs[1]!.text, 20), "FACT-A", "FACT-B"].join(" · ");
		expect(composeRow("HEAD", segs, displayWidth(expected))).toBe(expected);
	});

	it("facts are NEVER dropped, even when the row cannot fit", () => {
		const row = composeRow("HEAD", segs, 1);
		expect(row).toContain("FACT-A");
		expect(row).toContain("FACT-B");
		expect(row).not.toContain("hint");
	});

	it("an absent segment leaves no separator behind", () => {
		expect(composeRow("HEAD", [null, { kind: "fact", text: "X" }, undefined, { kind: "fact", text: "" }])).toBe("HEAD · X");
	});
});

describe("0.40.0 — the floor on the bar", () => {
	const BAR: BarInput = { mode: "bypass", floorOff: false, model: "m", ctx: { used: 0.2, soft: 0.5, hard: 0.8 }, tokPerSec: null, branch: null, folder: null };

	it("says nothing while the floor is on", () => {
		expect(statusBar(BAR, 80, null)).not.toContain("floor");
	});

	it("`floor off` is a FACT beside the tier: at a narrow width the hint goes and it stays", () => {
		expect(statusBar({ ...BAR, floorOff: true }, 120, null)).toBe("▸ bypass · floor off · /mode to switch · m · ctx 20%");
		const narrow = statusBar({ ...BAR, floorOff: true }, 34, null);
		expect(narrow).toContain("floor off");
		expect(narrow).not.toContain("/mode to switch");
	});
});
