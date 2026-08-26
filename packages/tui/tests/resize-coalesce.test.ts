/**
 * REL-0152-D18 — a window DRAG is one resize, not forty.
 *
 * The owner drags the window edge and the transcript fills with repeated
 * copies of the same live rows — six or more of the identical tool
 * block, each a little different where a counter had moved on.
 *
 * SIGWINCH fires continuously while a drag is in progress: every few
 * pixels is another signal. kiso answered each one immediately with an
 * erase and a full repaint. A real terminal REFLOWS on a width change
 * and pushes the rows it displaces into its scrollback — so every one of
 * those repaints deposited another copy of the screen into the history,
 * and a two-second drag deposits dozens.
 *
 * This is not something the renderer can be clever about after the fact:
 * the scrollback is not ours to rewrite. The only fix is to not paint
 * into the middle of a drag. A resize is COALESCED — the geometry is
 * adopted at once so nothing is computed at a stale width, but the
 * repaint waits for the drag to stop.
 *
 * The competitor does not have this problem for a structural reason
 * worth naming: it runs on the alternate screen, which has no scrollback
 * to accumulate into. kiso is on the primary screen deliberately — the
 * transcript IS the terminal's own scrollback, which is the product's
 * whole claim — so it pays for that choice here and has to pay
 * carefully.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";

function makeBody(H = 24) {
	let h = H;
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => h, width: () => 80, editCol: () => 1, write: (s) => writes.push(s) });
	return { body, writes, setH: (n: number) => { h = n; } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("REL-0152-D18 — a drag coalesces into one repaint", () => {
	it("forty SIGWINCHes in a drag produce ONE repaint, not forty", () => {
		const { body, writes, setH } = makeBody();
		body.enter();
		body.raw(["a committed line"]);
		vi.advanceTimersByTime(60);
		writes.length = 0;
		for (let i = 0; i < 40; i += 1) {
			setH(24 - (i % 6));
			body.onResize();
			vi.advanceTimersByTime(4); // a drag's signal cadence
		}
		const during = writes.join("");
		expect(during.split("\x1b[0J").length - 1, `the drag emitted ${during.split("\x1b[0J").length - 1} erase-downs`).toBeLessThanOrEqual(1);
		vi.advanceTimersByTime(200); // the drag stops
		expect(writes.join(""), "nothing repainted after the drag settled").toContain("a committed line");
	});

	it("the geometry is adopted IMMEDIATELY — nothing is computed at a stale width", () => {
		const { body, setH } = makeBody();
		body.enter();
		vi.advanceTimersByTime(60);
		setH(12);
		body.onResize();
		// the height the compositor reports must already be the new one,
		// even though the repaint has not happened yet: a live-region cap
		// computed at the old height would overflow the new screen.
		expect(body.liveCount()).toBeLessThanOrEqual(12);
	});

	it("a SINGLE resize still repaints promptly — the coalesce is not a delay tax", () => {
		const { body, writes, setH } = makeBody();
		body.enter();
		body.raw(["hello"]);
		vi.advanceTimersByTime(60);
		writes.length = 0;
		setH(20);
		body.onResize();
		vi.advanceTimersByTime(120);
		expect(writes.join("")).toContain("hello");
	});
});
