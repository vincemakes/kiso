/**
 * The main-sync round (owner, 2026-09-30): main's steers (ADR-0057) and
 * task deliveries (ADR-0058) drawn the Graphite way.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { noticeMeta } from "../src/notice-meta.js";
import { setGround } from "../src/lines.js";
import type { PanelState } from "../src/index.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

let tty: boolean | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	tty = process.stdout.isTTY;
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	delete process.env.NO_COLOR;
	setGround("light");
});
afterEach(() => {
	vi.useRealTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
	setGround("unknown");
});

const APPROVAL: PanelState = {
	view: { flavor: "approval", name: "shell", title: "npm run migrate", speaker: "default", statusText: "❯ run paused", args: { kind: "text", lines: ["npm run migrate"] }, fallbackQuestion: "approve shell? (y/n) " },
	phase: "options",
	cursor: 0,
};

function frame(opts: { steers: string[]; approval?: boolean; bar?: boolean }): string {
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => 30, width: () => 80, editCol: () => 1, write: (s) => writes.push(s) });
	body.bindInput(() => ({ line: "", cursor: 0 }), "› ");
	body.bindQueue(() => opts.steers);
	if (opts.approval === true) body.bindApproval(() => APPROVAL);
	if (opts.bar === true) body.setBar({ mode: "default", floorOff: false, model: "deepseek-flash", ctx: null, tokPerSec: null, branch: null, folder: null });
	body.enter();
	vi.advanceTimersByTime(50);
	return strip(writes.join(""));
}

describe("steers", () => {
	it("a steer that has not landed is a gold-marked row with what happens next — no label word, no queue", () => {
		const out = frame({ steers: ["also fix the typo"], bar: true });
		expect(out).toMatch(/◇ also fix the typo +next step · ↑ takes back/);
		expect(out).not.toContain("queued");
	});

	it("while an approval is open it lands after the approval — a steer never answers one", () => {
		const out = frame({ steers: ["also fix the typo"], approval: true, bar: true });
		expect(out).toContain("after the approval · ↑ takes back");
	});

	it("a Graphite bar does not count the steers — they are on screen as rows (DECLARED: main's `+N steer` is not drawn)", () => {
		const out = frame({ steers: ["one", "two"], bar: true });
		expect(out).not.toContain("+2 steer");
		expect(out).toContain("◇ one");
		expect(out).toContain("◇ two");
	});
});

describe("task deliveries", () => {
	it("main's `✦ task …` notice is a TASK meta row on a terminal", () => {
		expect(noticeMeta("✦ task t17 completed · t18 failed")).toEqual({ label: "TASK", sentence: "t17 completed · t18 failed" });
	});
});
