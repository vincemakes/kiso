/**
 * Graphite R1b — the transcript's words: meta rows (§7.12), the seal
 * (§7.11); and since R1e (owner, 2026-09-29), thinking with no label
 * (§7.2) and blocks spaced by one blank with no pad rows (§1.5).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { bodySpacing, cellComponent, type BodyCell } from "../src/components.js";
import { noticeMeta } from "../src/notice-meta.js";
import { renderRecap, sealTiers, setGround, type RecapStats } from "../src/lines.js";

const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
const CTX = { spinnerI: 0, now: 0, height: 24 };

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => {
	setGround("unknown");
	vi.useRealTimers();
});

describe("§7.12 — kiso's notices become meta rows", () => {
	it("each of kiso's session events maps to its label", () => {
		const cases: [string, string, string][] = [
			["✦ compacted mid-run — the conversation before this point is a summary now · ctx now ~40% used", "COMPACTED", "mid-run — the conversation before this point is a summary now · ctx now ~40% used"],
			["✦ pruned old tool output mid-run", "PRUNED", "old tool output mid-run"],
			["✦ window learned — deepseek-v4-flash is 1M", "WINDOW", "learned — deepseek-v4-flash is 1M"],
			["run failed — rate_limit 429 (retryable): slow down", "FAILED", "rate_limit 429 (retryable): slow down"],
			["shell FAILED — the side effect may have applied. boom", "UNCERTAIN", "shell — the side effect may have applied. boom"],
			['stopped at the 50-turn limit — the work is durable; say "continue" to carry on', "LIMIT", 'stopped at the 50-turn limit — the work is durable; say "continue" to carry on'],
			["stream interrupted — the draft above is abandoned", "INTERRUPTED", "the draft above is abandoned"],
		];
		for (const [text, label, sentence] of cases) expect(noticeMeta(text), text).toEqual({ label, sentence });
	});

	it("a command's confirmation has no kind of its own: no label, the sentence whole", () => {
		for (const text of ["mode → plan (shift+tab cycles)", "[/compact] nothing to compact — fewer than 5 rounds yet", "[dontAsk] shell would ask — denied", "[exit queued — closing after the current run completes]", "model → ds (deepseek-v4-flash · max)"]) {
			expect(noticeMeta(text), text).toEqual({ sentence: text });
		}
		expect(noticeMeta("✦ something else"), "the seal's mark comes off").toEqual({ sentence: "something else" });
	});

	it("…and such a row sits whole at the content edge", () => {
		const rows = cellComponent({ kind: "notice", text: "mode → plan", done: true, sentence: "mode → plan" } as BodyCell).render(60, CTX).map(plain);
		expect(rows).toEqual(["  mode → plan"]); // the content edge is column 2 (R1f)
	});

	it("an indented notice continues the one above it: no label of its own", () => {
		expect(noticeMeta("  the tests pass")).toEqual({ label: "", sentence: "the tests pass" });
	});

	it("a meta row: the label at the content edge, the sentence at column 14, folded under itself", () => {
		const cell = { kind: "notice", text: "x", done: true, label: "COMPACTED", sentence: "alpha bravo charlie delta echo foxtrot golf hotel india" } as BodyCell;
		const rows = cellComponent(cell).render(40, CTX).map(plain);
		expect(rows[0]!.startsWith("  COMPACTED   alpha")).toBe(true);
		for (const r of rows.slice(1)) expect(r.match(/^ */)![0].length).toBe(14);
		for (const r of rows) expect(r.length).toBeLessThanOrEqual(40);
	});

	it("a label that names an outcome takes its colour (§1.2); the others stay dim", () => {
		setGround("light");
		const failed = cellComponent({ kind: "notice", text: "x", done: true, label: "FAILED", sentence: "boom" } as BodyCell).render(60, CTX)[0]!;
		const noted = cellComponent({ kind: "notice", text: "x", done: true, label: "NOTE", sentence: "hi" } as BodyCell).render(60, CTX)[0]!;
		expect(failed).toMatch(/\x1b\[38;2;179;38;30mFAILED/);
		expect(noted).not.toMatch(/\x1b\[38;2;179;38;30m/);
	});

	it("the compositor derives the label; a pipe prints the notice exactly as written", () => {
		const out: string[] = [];
		const piped = new Body({ active: () => false, height: () => 24, width: () => 80, editCol: () => 1, write: (s) => out.push(s) });
		piped.notice("✦ compacted mid-run — a summary now");
		expect(out.join("")).toBe("✦ compacted mid-run — a summary now\n");
	});
});

describe("§7.11 — the seal", () => {
	const base: RecapStats = { seconds: 4, usage: { known: true, in: 1300, out: 910, cache: 31_000 }, ctxLeftPct: 91, width: 80 } as unknown as RecapStats;

	it("today's facts in today's words — took, fresh/out, cache — and no context share", () => {
		const [line] = sealTiers(base);
		expect(line).toBe("took 4s · fresh 1.3k out 910 · cache 96%");
		expect(line).not.toContain("ctx");
	});

	it("a stopped turn says so, and that everything before the stop is saved", () => {
		expect(sealTiers({ ...base, stopped: true })[0]).toBe("stopped by you after 4s · fresh 1.3k out 910 · cache 96% · everything up to here is saved");
	});

	it("a cold cache sheds its label before anything is cut (R3g)", () => {
		const tiers = sealTiers({ ...base, coldAfterMinutes: 12, missed: 48_000 });
		expect(tiers).toHaveLength(2);
		expect(tiers[0]).toContain("cache cold after 12 min");
		expect(tiers[1]).toContain("cold 12 min");
	});

	it("plan mode keeps its way-forward row — whole at 80 columns, the exits are its only controls (W19)", () => {
		const tiers = sealTiers({ ...base, mode: "plan" });
		expect(tiers[0]).toBe("plan ready · /mode default executes · /mode accept-edits auto-approves edits");
		const row = plain(cellComponent({ kind: "seal", tiers, done: true } as BodyCell).render(80, CTX)[0]!);
		expect(row).toBe(`✦ ${tiers[0]}`); // the mark in column 0, the words at the edge (R1f)
	});

	it("the mark hangs in the mark column, the words at the edge; one row at every width (invariant ①)", () => {
		const cell = { kind: "seal", tiers: sealTiers({ ...base, coldAfterMinutes: 12, missed: 48_000 }), done: true } as BodyCell;
		for (let W = 12; W <= 200; W += 1) {
			const rows = cellComponent(cell).render(W, CTX);
			expect(rows).toHaveLength(1);
			expect(plain(rows[0]!).length, `W=${W}`).toBeLessThanOrEqual(W);
			expect(plain(rows[0]!).startsWith("✦ ")).toBe(true);
		}
	});

	it("a PIPE gets today's recap bytes exactly — the line and the blank row after it", () => {
		const out: string[] = [];
		const piped = new Body({ active: () => false, height: () => 24, width: () => 80, editCol: () => 1, write: (s) => out.push(s) });
		piped.seal(sealTiers(base), renderRecap(base));
		const before: string[] = [];
		const old = new Body({ active: () => false, height: () => 24, width: () => 80, editCol: () => 1, write: (s) => before.push(s) });
		old.raw(renderRecap(base).split("\n"));
		expect(out.join("")).toBe(before.join(""));
		expect(out.join("")).toContain("ctx left");
	});
});

describe("§7.2 — thinking carries no label (owner, 2026-09-29)", () => {
	it("the block streams and settles as grey italic prose at the edge — no THINK row, no clock", () => {
		const writes: string[] = [];
		const body = new Body({ active: () => true, height: () => 24, width: () => 80, editCol: () => 1, write: (s) => writes.push(s) });
		body.enter();
		body.userLine("go");
		body.thinkingAppend("weighing it");
		vi.advanceTimersByTime(5_200);
		body.thinkingEnd();
		body.textAppend("done.");
		vi.advanceTimersByTime(50);
		const said = plain(writes.join(""));
		expect(said).toContain("weighing it");
		expect(said).not.toContain("THINK");
	});
});

describe("§1.5 — surfaces are backgrounds; blocks are spaced by one blank, always", () => {
	it("the pad-join rule retired with the pads: every pair of blocks gets its one blank (R13 D1)", () => {
		expect(bodySpacing(["x"], ["y"])).toEqual(["", "y"]);
		expect(bodySpacing(["x", "▀▀▀▀"], ["▄▄▄▄", "y"])).toEqual(["", "▄▄▄▄", "y"]);
	});
});
