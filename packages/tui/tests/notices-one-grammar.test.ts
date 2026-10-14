/**
 * The notices round (owner, 2026-10-14): a command that CHANGED something
 * the person set leaves a labelled row in the stream, like MODE and
 * COMPACTED do. `/model` is MODE's sibling (a gold label, `from → to`, the
 * new profile bold); the sentences that were bare at the content edge take
 * the label of what they are. A reply that only informs stays whole.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { cellComponent } from "../src/components.js";
import { setGround, palette } from "../src/lines.js";
import { noticeMeta } from "../src/notice-meta.js";

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const CTX = { spinnerI: 0, now: 0, height: 24 };

let tty: boolean | undefined;
beforeEach(() => {
	tty = process.stdout.isTTY;
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	delete process.env.NO_COLOR;
	setGround("dark");
});
afterEach(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
	setGround("unknown");
});

/** a body on a dock (or a pipe) and what it wrote once the frame settled */
const run = (active: boolean, fn: (b: Body) => void): string => {
	const writes: string[] = [];
	const b = new Body({ active: () => active, height: () => 24, width: () => 100, editCol: () => 1, write: (s) => writes.push(s) });
	if (active) b.enter();
	vi.useFakeTimers();
	fn(b);
	vi.advanceTimersByTime(50);
	vi.useRealTimers();
	return writes.join("");
};

describe("MODEL, the MODE row's sibling", () => {
	const TEXT = "model → ds (deepseek-v4-flash @api.deepseek.com · high) — takes effect on the next turn";

	it("draws MODEL gold, then `from → to` with the new profile bold, then what it carries", () => {
		const p = palette();
		const rows = cellComponent({ kind: "notice", text: TEXT, done: true, label: "MODEL", sentence: "claude → ds · deepseek-v4-flash @api.deepseek.com · high · takes effect on the next turn", mark: { text: "ds", tone: "ink" }, stacked: true }).render(100, CTX);
		expect(plain(rows[0]!)).toBe("  MODEL  claude → ds · deepseek-v4-flash @api.deepseek.com · high · takes effect on the next turn");
		expect(rows[0]).toContain(`${p.bold}${p.gold}MODEL${p.reset}`);
		expect(rows[0]).toContain(`${p.bold}ds${p.reset}`);
	});

	it("the compositor pushes that cell on a terminal, and a pipe keeps the old words byte for byte", () => {
		const live = plain(run(true, (b) => b.modelNotice(TEXT, "claude", "ds", "deepseek-v4-flash @api.deepseek.com · high · takes effect on the next turn")));
		expect(live).toContain("MODEL  claude → ds · deepseek-v4-flash @api.deepseek.com · high · takes effect on the next turn");
		expect(run(false, (b) => b.modelNotice(TEXT, "claude", "ds", "anything"))).toBe(`${TEXT}\n`);
	});

	it("an empty tail leaves no trailing separator", () => {
		const live = plain(run(true, (b) => b.modelNotice("model → a", "b", "a", "")));
		expect(live).toContain("MODEL  b → a");
		expect(live).not.toContain("a ·");
	});
});

describe("don't ask, set to what it already is", () => {
	it("is a row: `already on`, not a bare sentence; a pipe keeps the old words", () => {
		expect(plain(run(true, (b) => b.dontAskNotice("don't ask → on", true, true)))).toContain("DON'T ASK  already on");
		expect(run(false, (b) => b.dontAskNotice("don't ask → on", true, true))).toBe("don't ask → on\n");
	});
});

describe("the sentences that were bare at the content edge now name what they are", () => {
	const labelled: readonly (readonly [string, string, string])[] = [
		["✦ compaction discarded — the checkpoint did not shrink the context (~180.4k → ~196k; it wrote ~60k)", "COMPACTED", "discarded · the checkpoint did not shrink the context (~180.4k → ~196k; it wrote ~60k)"],
		["✦ chain budget spent — 20 autonomous wakes since your last message · finished tasks wait for you", "BUDGET", "chain spent · 20 autonomous wakes since your last message · finished tasks wait for you"],
		["✦ kiso 9.9.9 is installed — this session runs 0.49.0; exit and resume it (kiso resume s) to use it", "UPDATE", "kiso 9.9.9 is installed · this session runs 0.49.0; exit and resume it (kiso resume s) to use it"],
		['named "retry work"', "NAME", "retry work"],
		["name cleared — /resume lists it by its first line again", "NAME", "cleared · /resume lists it by its first line again"],
		["name: retry work · /name - clears it", "NAME", "retry work · /name - clears it"],
		['unnamed — /resume lists it as "x" · /name <words> names it', "NAME", 'unnamed · /resume lists it as "x" · /name <words> names it'],
		["t1: stop requested", "TASK", "t1 · stop requested"],
		["t1: nothing to stop (done)", "TASK", "t1 · nothing to stop (done)"],
		["[reload] 3 extensions, 2 skills — the conversation is unchanged", "RELOAD", "3 extensions, 2 skills · the conversation is unchanged"],
		["--- 4 earlier blocks not re-wrapped (bounded at two screens) ---", "REWRAPPED", "4 earlier blocks not re-wrapped · bounded at two screens"],
	];
	it.each(labelled)("%s", (text, label, sentence) => {
		const m = noticeMeta(text);
		expect(m.label, text).toBe(label);
		expect(m.sentence, text).toBe(sentence);
	});

	it("a failed reload marks `failed` in the failure colour", () => {
		const m = noticeMeta("[reload] EACCES — nothing changed, the previous set is still in force");
		expect(m.mark).toEqual({ text: "failed", tone: "fail" });
	});

	it("a discarded checkpoint marks `discarded` in the failure colour", () => {
		expect(noticeMeta("✦ compaction discarded — x").mark).toEqual({ text: "discarded", tone: "fail" });
	});

	// the guard that keeps the table from swallowing replies that only inform
	it.each(["copied 48 chars", "no tasks in this session", "unknown command: /x — /help lists the commands", "nothing to copy", "[no thinking yet]"])("%s stays whole, with no label", (text) => {
		expect(noticeMeta(text).label, text).toBeUndefined();
	});
});
