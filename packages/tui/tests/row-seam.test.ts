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
 */

import { describe, expect, it } from "vitest";
import { elapsedLabel } from "@vincemakes/kiso-tui-cells";
import { displayWidth } from "@vincemakes/kiso-tui-cells/width";
import { kUnit } from "../src/lines.js";
import { compactingStatus, composeRow, idleStatus, runningStatus, type StatusMeter } from "../src/status.js";

// ── The oracle: the pre-seam implementations, verbatim ──────────────────

const ctxSegment = (ratio: number): string => (Number.isFinite(ratio) ? `ctx left ~${Math.round((1 - ratio) * 100)}%` : "ctx ?");

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

function oldIdle(tier: string, model: string, ctxRatio: number, meter?: StatusMeter, W?: number): string {
	const compose = (label: string, hint: boolean): string => {
		const parts = [`▸ ${tier}`];
		if (hint) parts.push("/mode to switch");
		parts.push(label);
		if (meter?.cacheHitPct != null) parts.push(`CH ${Math.round(meter.cacheHitPct)}%`);
		parts.push(ctxSegment(ctxRatio));
		if (meter?.tokPerSec != null) parts.push(`${meter.tokPerSec} tok/s`);
		return parts.join(" · ");
	};
	const full = compose(model, true);
	if (W === undefined || displayWidth(full) <= W) return full;
	const squeezed = compose(elideMiddle(model, 20), true);
	if (displayWidth(squeezed) <= W) return squeezed;
	return compose(elideMiddle(model, 20), false);
}

function oldRunning(glyph: string, since: number, outTokens: number | null, ctxRatio: number, tokPerSec: number | null = null): string {
	const out = outTokens !== null ? ` ↓ ${kUnit(outTokens)} tokens` : "";
	const rate = tokPerSec !== null ? ` · ${tokPerSec} tok/s` : "";
	const seconds = Math.max(1, Math.round((Date.now() - since) / 1000));
	return `${glyph} working ${elapsedLabel(seconds)}${out}${rate} · esc stop · alt+⏎ redirect · ${ctxSegment(ctxRatio)}`;
}

// RE-DERIVED (the compaction round, owner 2026-10-06): one round is
// `1 round` — the template said `1 rounds`; every other byte is unchanged
const oldCompacting = (glyph: string, rounds: number, tokens: number, elapsed: number): string =>
	`${glyph} compacting · ${rounds} round${rounds === 1 ? "" : "s"} · ~${kUnit(tokens)} tokens · ${Math.max(0, elapsed)}s`;

// ── The grid ────────────────────────────────────────────────────────────

const TIERS = ["default", "plan (read-only)", "bypass", "accept-edits"];
const MODELS = ["m", "deepseek-flash", "deepseek/deepseek-v4-flash", "gpt-5.6-sol · xhigh", "claude-opus-4-8-with-an-unreasonably-long-suffix-0910", "\u6a21\u578b".repeat(14)];
const RATIOS = [0, 0.37, 0.999, Number.NaN];
const METERS: (StatusMeter | undefined)[] = [
	undefined,
	{ cacheHitPct: null, costUsd: null, tokPerSec: null },
	{ cacheHitPct: 91.4, costUsd: 0.12, tokPerSec: null },
	{ cacheHitPct: 12, costUsd: null, tokPerSec: 57 },
];
const WIDTHS: (number | undefined)[] = [undefined, 200, 120, 100, 80, 60, 40, 20, 1];

describe("the seam changes nothing — the new rows equal the old ones, byte for byte", () => {
	it("the idle row, across the whole grid including every width path", () => {
		let n = 0;
		for (const t of TIERS) for (const m of MODELS) for (const r of RATIOS) for (const me of METERS) for (const W of WIDTHS) {
			expect(idleStatus(t, m, r, me, W), `tier=${t} model=${m} ratio=${r} meter=${JSON.stringify(me)} W=${W}`).toBe(oldIdle(t, m, r, me, W));
			n += 1;
		}
		expect(n).toBe(TIERS.length * MODELS.length * RATIOS.length * METERS.length * WIDTHS.length);
	});

	it("the running row, when called as every caller calls it today (no width)", () => {
		const since = Date.now() - 42_000;
		for (const out of [null, 0, 950, 20_300, 1_200_000]) for (const r of RATIOS) for (const tps of [null, 1, 57]) {
			expect(runningStatus("✦", since, out, r, tps)).toBe(oldRunning("✦", since, out, r, tps));
		}
	});

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

describe("0.40.0 — the floor on the idle row", () => {
	it("says nothing while the floor is on: the row is the row it always was", () => {
		expect(idleStatus("bypass", "m", 0.2, undefined, 80, false)).toBe(idleStatus("bypass", "m", 0.2, undefined, 80));
		expect(idleStatus("bypass", "m", 0.2)).not.toContain("floor");
	});

	it("`floor off` is a FACT beside the tier: at a narrow width the hint goes and it stays", () => {
		expect(idleStatus("bypass", "m", 0.2, undefined, undefined, true)).toBe("▸ bypass · floor off · /mode to switch · m · ctx left ~80%");
		const narrow = idleStatus("bypass", "m", 0.2, undefined, 30, true);
		expect(narrow).toContain("floor off");
		expect(narrow).not.toContain("/mode to switch");
	});
});
