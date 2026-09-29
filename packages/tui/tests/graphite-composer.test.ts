/**
 * Graphite R1c — the composer and the status bar: the bar's facts and
 * what gives way (§8.5, §8.9), the ctx meter's tiers (§8.9), the live row
 * (§8.7), the queued rows (§8.7), and the composer (§7.8).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body, type InputState } from "../src/compositor.js";
import { ctxMeter, liveRow, statusBar, workingRow, type BarInput } from "../src/status.js";
import { palette, setGround } from "../src/lines.js";
import { pendingQueueRows } from "@vincemakes/kiso-tui-cells/components";
import { Screen } from "./helpers/screen.js";

const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");

beforeEach(() => {
	vi.useFakeTimers();
	delete process.env.NO_COLOR;
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => {
	setGround("unknown");
	vi.useRealTimers();
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

const MODEL = "deepseek-v4-flash · max";
const BAR: BarInput = {
	mode: "default",
	floorOff: false,
	model: MODEL,
	ctx: { used: 0.09, soft: 0.5, hard: 0.8 },
	tokPerSec: 48,
	branch: "main",
	folder: "~/code/kiso",
};

describe("§8.9 — the status bar's facts", () => {
	it("a known ground: the chip, the words spaced, the branch and folder at the right", () => {
		setGround("light");
		const row = plain(statusBar(BAR, 200, "expand all"));
		expect(row).toMatch(/^ default {3}\/mode to switch {2}deepseek-v4-flash · max {2}ctx ▆{10} 9% {2}48 tok\/s +main {2}~\/code\/kiso {2}ctrl\+o expand all$/);
		expect(row.length).toBe(200);
	});

	it("an unknown ground: the same facts in words that survive without colour", () => {
		const row = plain(statusBar(BAR, 200, null));
		expect(row).toMatch(/^▸ default · \/mode to switch · deepseek-v4-flash · max · ctx 9% · 48 tok\/s +main  ~\/code\/kiso$/);
	});

	it("plan's posture, bypass in the failure colour, floor off only when off", () => {
		setGround("light");
		const p = palette();
		expect(plain(statusBar({ ...BAR, mode: "plan · read-only" }, 200, null))).toContain(" plan · read-only ");
		expect(statusBar({ ...BAR, mode: "bypass", modeAlert: true }, 200, null).startsWith(`${p.fail}`)).toBe(true);
		expect(plain(statusBar(BAR, 200, null))).not.toContain("floor off");
		expect(statusBar({ ...BAR, floorOff: true }, 200, null)).toContain(`${p.fail}floor off`);
	});

	it("unmeasured facts are absent, not zero", () => {
		const row = plain(statusBar({ ...BAR, tokPerSec: null, branch: null }, 200, null));
		expect(row).not.toContain("tok/s");
		expect(row).not.toContain("main");
	});
});

describe("§8.5 — what gives way, W 20..200, on both grounds", () => {
	for (const ground of ["light", "unknown"] as const) {
		it(`${ground}: the row fits; the hint, then the folder, then the branch, then the model's middle, and last /mode to switch`, () => {
			setGround(ground);
			for (let W = 20; W <= 200; W += 1) {
				const row = plain(statusBar(BAR, W, "expand all"));
				const at = `W=${W}: ${row}`;
				expect(row.length, at).toBeLessThanOrEqual(W);
				const has = (s: string): boolean => row.includes(s);
				const hint = has("ctrl+o");
				const folder = has("~/code/kiso");
				const branch = / main( |$)/.test(row);
				const model = has(MODEL);
				const modeKey = has("/mode to switch");
				if (hint) expect(folder && branch && model && modeKey, at).toBe(true);
				if (folder) expect(branch && model && modeKey, at).toBe(true);
				if (branch) expect(model && modeKey, at).toBe(true);
				if (!model && modeKey) expect(row, at).toContain("…");
			}
		});

		it(`${ground}: the facts never drop — at 80 columns every one is on the row`, () => {
			setGround(ground);
			const row = plain(statusBar(BAR, 80, "expand all"));
			for (const fact of ["default", "ctx", "9%", "48 tok/s"]) expect(row, row).toContain(fact);
			expect(row, "the model survives, elided in its middle at most").toMatch(/deepseek-v|…/);
		});
	}

	it("the widest rows keep everything", () => {
		setGround("light");
		const row = plain(statusBar(BAR, 140, "collapse all"));
		for (const s of ["/mode to switch", MODEL, "main", "~/code/kiso", "ctrl+o collapse all"]) expect(row).toContain(s);
	});
});

describe("§8.9 — the ctx meter", () => {
	it("`ctx ?` when the window is unknown; the percentage alone off a known ground", () => {
		expect(ctxMeter(null)).toBe("ctx ?");
		expect(ctxMeter({ used: Number.NaN, soft: 0.5, hard: 0.8 })).toBe("ctx ?");
		expect(ctxMeter({ used: 0.42, soft: 0.5, hard: 0.8 })).toBe("ctx 42%");
	});

	it("ten cells following the percentage SHOWN: empty at 0%, at least one from 1% (owner, 2026-09-29)", () => {
		setGround("light");
		const p = palette();
		const filled = (used: number): number => {
			const m = ctxMeter({ used, soft: 0.5, hard: 0.8 });
			const run = m.slice(m.indexOf(p.ink2) + p.ink2.length, m.indexOf(p.track));
			return [...run].length;
		};
		expect(plain(ctxMeter({ used: 0, soft: 0.5, hard: 0.8 }))).toBe("ctx ▆▆▆▆▆▆▆▆▆▆ 0%");
		// a lit cell beside `0%` read as a contradiction: 0.4% shows 0% and no cell
		expect(filled(0.004)).toBe(0);
		expect(plain(ctxMeter({ used: 0.004, soft: 0.5, hard: 0.8 }))).toBe("ctx ▆▆▆▆▆▆▆▆▆▆ 0%");
		expect(filled(0.01)).toBe(1);
		expect(filled(0.14)).toBe(1);
		expect(filled(0.16)).toBe(2);
		expect(filled(0.44)).toBe(4);
	});

	it("the tier is the colour: ink2 below soft, gold from soft, fail past hard — read from the tiers given", () => {
		setGround("light");
		const p = palette();
		const tone = (used: number, soft: number, hard: number): string => {
			const m = ctxMeter({ used, soft, hard });
			return m.slice(m.indexOf(" ") + 1, m.indexOf("▆"));
		};
		expect(tone(0.3, 0.5, 0.8)).toBe(p.ink2);
		expect(tone(0.5, 0.5, 0.8)).toBe(p.gold);
		expect(tone(0.85, 0.5, 0.8)).toBe(p.fail);
		// the same share, other tiers: never a fixed fraction
		expect(tone(0.5, 0.7, 0.9)).toBe(p.ink2);
		expect(tone(0.5, 0.3, 0.45)).toBe(p.fail);
	});
});

describe("§8.7 — the live row", () => {
	it("`working` the whole turn, with the elapsed, the output tokens and the rate", () => {
		const since = Date.now() - 12_000;
		const row = plain(workingRow("✦", since, 1_300, 48, 120, null));
		expect(row).toMatch(/^✦ working 12s · ↓ 1\.3k · 48 tok\/s +esc stop · ⏎ queue · alt\+⏎ redirect$/);
		expect(row).not.toContain("thinking");
	});

	it("a pending retry replaces `working` while it lasts: the attempt, what failed, the countdown", () => {
		const row = plain(workingRow("✦", Date.now() - 12_000, 1_300, 48, 80, { attempt: 2, maxRetries: 10, code: "rate_limit", remainingMs: 3_200 }));
		expect(row).toMatch(/^↻ retrying 2\/10 · rate_limit · next try in 4s +esc gives up$/);
		expect(row).not.toContain("working");
		const inFlight = plain(workingRow("✦", Date.now(), null, null, 80, { attempt: 2, maxRetries: 10, code: "rate_limit", remainingMs: 0 }));
		expect(inFlight).toMatch(/^↻ retrying 2\/10 · rate_limit +esc gives up$/);
	});

	it("the keys give way from the right, whole; the facts are never cut before them", () => {
		const facts = "✦ working 12s · ↓ 1.3k";
		for (let W = 10; W <= 120; W += 1) {
			const row = plain(liveRow(facts, ["esc stop · ⏎ queue · alt+⏎ redirect", "esc stop · ⏎ queue", "esc stop"], W));
			expect(row.length, `W=${W}`).toBeLessThanOrEqual(W);
			if (row.includes("esc")) expect(row.startsWith(facts), `W=${W}: ${row}`).toBe(true);
			const keys = row.slice(facts.length).trim();
			expect(["", "esc stop · ⏎ queue · alt+⏎ redirect", "esc stop · ⏎ queue", "esc stop"], `W=${W}: ${row}`).toContain(row.startsWith(facts) ? keys : "");
		}
	});
});

describe("§8.7 — a queued message is one row", () => {
	it("the mark, the word, the text, the keys that edit it", () => {
		const [row] = pendingQueueRows(["tidy the imports"], 80).map(plain);
		expect(row).toMatch(/^◇ queued {2}tidy the imports +after this turn · ↑ edit$/);
		expect(row!.length).toBe(80);
	});

	it("a long message elides before its keys go; a narrow row keeps the text", () => {
		const long = "x".repeat(200);
		const [wide] = pendingQueueRows([long], 80).map(plain);
		expect(wide).toContain("…");
		expect(wide!.endsWith("after this turn · ↑ edit")).toBe(true);
		for (let W = 12; W <= 100; W += 1) for (const r of pendingQueueRows([long, "hi"], W)) expect(plain(r).length, `W=${W}`).toBeLessThanOrEqual(W);
	});
});

/**
 * Graphite §7.8 — the composer: `›` in column 0, the text at column 2
 * (owner, 2026-09-29: no two-space indent — what you type lines up with
 * what you sent), and an EMPTY input shows nothing. DECLARED REMOVAL of
 * R1c's key ladder placeholder: `?` lists the keys, and the empty row is
 * kept for later work to speak in.
 */
describe("§7.8 — the composer", () => {
	const make = (W: number, input: () => InputState) => {
		const writes: string[] = [];
		const body = new Body({ active: () => true, height: () => 24, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
		body.bindInput(input, "› ");
		body.enter();
		body.redraw();
		const screen = (): string[] => {
			vi.advanceTimersByTime(16);
			const sc = new Screen(W, 24);
			sc.feed(writes.join(""));
			return sc.rows.map((r) => r.join("").replace(/\s+$/, ""));
		};
		return { body, screen };
	};

	it("the empty input is the `›` alone — no placeholder, idle or not", () => {
		const { body, screen } = make(100, () => ({ line: "", cursor: 0 }));
		expect(screen()[21]).toBe("›");
		body.setLive("✦ working 1s");
		expect(screen()[21]).toBe("›");
		expect(screen()[19], "the live row stands above the composer's rule").toBe("✦ working 1s");
	});

	it("typed text starts at column 2", () => {
		const line = "fix the resize repaint";
		const { screen } = make(100, () => ({ line, cursor: line.length }));
		expect(screen()[21]).toBe(`› ${line}`);
	});

	it("a flash rides the live row until the next key", () => {
		const { body, screen } = make(80, () => ({ line: "", cursor: 0 }));
		body.flash("copied 212 chars");
		expect(screen()[19]).toBe("  copied 212 chars");
		body.redraw(true);
		expect(screen()[19]).toBe("");
	});
});
