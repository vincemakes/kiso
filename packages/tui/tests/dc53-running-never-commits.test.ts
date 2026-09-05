/**
 * DC-53 — the live region's cap loop force-committed a call that was
 * STILL RUNNING, and the placeholder then lied about it.
 *
 * Three parallel searches; the second and third settle first. Their two
 * cards are twelve rows each, the live region passes `H − 4`, and the
 * cap loop commits `#committed` unconditionally — which is the FIRST
 * call, still in flight. Its three-row running card, breathing mark and
 * all, is frozen into the scrollback; `#committed` steps past it; and
 * when its result finally arrives there is no longer a live cell to draw
 * it into. The work is lost from the screen.
 *
 * Then the live projection is empty, and `#thinkingGap()` asked only
 * whether the turn was in flight — so `thinking…` appeared beside a call
 * that was running. That is the row in the owner's screenshot.
 *
 * The loop is not new; R4's standing slot is what kept it away from a
 * running cell, because the slot held the live region at a constant
 * height and the projection never grew past the cap on its own. R13
 * retired the slot (DC-46), and this is the first time the loop has
 * reached a cell that was not done.
 *
 * THE RULE: a cell that is not done is never committed. When the queue's
 * head is running and the region is over its cap, the ones BEHIND it
 * give way first — settled cards degrade to head rows, then the running
 * card's window shrinks (DC-43's shape), and only then does the overflow
 * become a `+N more` count. Order is always call order.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { setGround } from "@vincemakes/kiso-tui-cells/render";
import { VtScrollback } from "./vt-scrollback.js";

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	setGround("light");
});
afterEach(() => {
	vi.useRealTimers();
	setGround("unknown");
});

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const W = 100;
const H = 24;

function makeBody() {
	const out: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => out.push(s) });
	const everything = (): string[] => {
		const vt = new VtScrollback(W, H);
		vt.feed(out.join(""));
		return [...vt.scrollback, ...Array.from({ length: H }, (_, i) => vt.line(i + 1))].map((l) => plain(l).replace(/\s+$/, ""));
	};
	const screen = (): string[] => {
		const vt = new VtScrollback(W, H);
		vt.feed(out.join(""));
		return Array.from({ length: H }, (_, i) => plain(vt.line(i + 1)).replace(/\s+$/, ""));
	};
	return { body, out, everything, screen, tick: () => vi.advanceTimersByTime(30) };
}

const lines = (n: number, f: (i: number) => string): string => Array.from({ length: n }, (_, i) => f(i)).join("\n");

/** The owner's shape: three parallel searches, the LAST TWO settling
 *  first and each big enough to push the region past its cap. */
function parallelBurst(body: Body): void {
	for (const [id, path] of [["s1", "Desktop"], ["s2", "Documents"], ["s3", "Downloads"]] as const) {
		body.toolStart("search_text", id, { pattern: "kiso", path });
		body.toolRunning(id);
	}
	body.toolResult("s2", { content: lines(30, (i) => `Documents/hit ${i + 1}`), isError: false });
	body.toolResult("s3", { content: lines(30, (i) => `Downloads/hit ${i + 1}`), isError: false });
}

describe("DC-53 — a running call is never committed", () => {
	it("the RUNNING card stays on the screen while the settled ones fill it", () => {
		const { body, screen, tick } = makeBody();
		body.enter();
		body.userLine("search three places");
		parallelBurst(body);
		tick();
		expect(screen().join("\n"), "the running call left the screen").toMatch(/search .*Desktop/);
	});

	it("NOTHING with a breathing mark ever reaches the scrollback", () => {
		const { body, out, tick } = makeBody();
		body.enter();
		body.userLine("search three places");
		parallelBurst(body);
		tick();
		const vt = new VtScrollback(W, H);
		vt.feed(out.join(""));
		const frozen = vt.scrollback.map(plain);
		expect(frozen.filter((l) => l.includes("●")), "a running card was frozen into the scrollback").toEqual([]);
	});

	it("the placeholder never appears while a call is in flight", () => {
		const { body, screen, tick } = makeBody();
		body.enter();
		body.userLine("search three places");
		parallelBurst(body);
		tick();
		expect(screen().some((l) => l.trim() === "thinking…"), "`thinking…` beside a running call").toBe(false);
	});

	it("…and when the last call settles, its result appears IN CALL ORDER", () => {
		const { body, everything, tick } = makeBody();
		body.enter();
		body.userLine("search three places");
		parallelBurst(body);
		tick();
		body.toolResult("s1", { content: lines(30, (i) => `Desktop/hit ${i + 1}`), isError: false });
		body.textAppend("done.\n");
		body.textEnd();
		body.endTurn(0);
		tick();
		const all = everything();
		const at = (needle: string): number => all.findIndex((l) => l.includes(needle));
		expect(at("Desktop/hit 1"), "the first call's result never appeared at all").toBeGreaterThanOrEqual(0);
		expect(at("Desktop/hit 1"), "the results are out of call order").toBeLessThan(at("Documents/hit 1"));
		expect(at("Documents/hit 1")).toBeLessThan(at("Downloads/hit 1"));
	});

	it("ten parallel reads on a 24-row terminal degrade to head rows, never to a committed running cell", () => {
		const { body, out, tick } = makeBody();
		body.enter();
		body.userLine("read ten");
		for (let i = 0; i < 10; i += 1) {
			body.toolStart("read_file", `r${i}`, { path: `f${i}.ts` });
			body.toolRunning(`r${i}`);
		}
		for (let i = 1; i < 10; i += 1) body.toolResult(`r${i}`, { content: lines(20, (j) => `l${j}`), isError: false });
		tick();
		const vt = new VtScrollback(W, H);
		vt.feed(out.join(""));
		expect(vt.scrollback.map(plain).filter((l) => l.includes("●")), "a running card was frozen into the scrollback").toEqual([]);
	});
});
