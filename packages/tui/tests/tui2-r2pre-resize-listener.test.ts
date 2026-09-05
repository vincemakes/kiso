/**
 * TUI2-R2pre ③ — the resize listener leak.
 *
 * The suite emits `MaxListenersExceededWarning: 11 resize listeners added
 * to [Socket]` from six worker processes. Node's warning is the symptom;
 * the defect is that `enter()` ADDS a listener to the process-wide
 * `process.stdout` and only `exit()` removes it, so:
 *   - a second enter() without an exit() strands the first handler, since
 *     #resizeHandler has already been overwritten and nothing holds it;
 *   - a NEW Body supersedes the old one through the module-scope
 *     compositorRef, and the superseded compositor keeps listening —
 *     a resize then makes a compositor that owns no part of the screen
 *     write a full repaint to it.
 *
 * The second one is the product bug behind the test noise, and it is why
 * the gate below counts listeners rather than grepping for the warning:
 * the count is the invariant, the warning is just where it surfaced.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";

const listeners = (): number => process.stdout.listenerCount("resize");

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});

afterEach(() => {
	vi.useRealTimers();
	delete (process.stdout as { rows?: number }).rows;
	delete (process.stdout as { columns?: number }).columns;
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

function makeBody() {
	return new Body({
		active: () => true,
		height: () => 24,
		width: () => 80,
		editCol: () => 1,
		write: () => {},
	});
}

describe("TUI2-R2pre ③ — the dock's resize listener is a singleton", () => {
	it("T-R2p-8: N enter/exit cycles leave the listener count at baseline", () => {
		const base = listeners();
		const body = makeBody();
		for (let i = 0; i < 20; i += 1) {
			body.enter();
			body.exit();
		}
		expect(listeners()).toBe(base);
	});

	it("T-R2p-9: a repeated enter() without an exit() never strands a handler", () => {
		// the CLI enters once per command today, but nothing in the API says
		// so, and the stranded handler is unreachable: #resizeHandler has
		// been overwritten, so even exit() cannot remove it.
		const base = listeners();
		const body = makeBody();
		for (let i = 0; i < 20; i += 1) body.enter();
		expect(listeners()).toBe(base + 1);
		body.exit();
		expect(listeners()).toBe(base);
	});

	it("T-R2p-10: a superseded compositor stops listening — 20 Bodys, one listener", () => {
		// this is the shape the test suite hits (a fresh Body per case) and
		// the shape that matters in the product: compositorRef points at the
		// newest Body, so an older one that still hears `resize` would repaint
		// a screen it no longer owns.
		const base = listeners();
		const bodies: Body[] = [];
		for (let i = 0; i < 20; i += 1) {
			const b = makeBody();
			b.enter();
			bodies.push(b);
		}
		expect(listeners()).toBeLessThanOrEqual(base + 1);
		bodies[bodies.length - 1]!.exit();
		expect(listeners()).toBe(base);
	});

	it("T-R2p-11: exit() is idempotent and enter() still installs a WORKING handler", () => {
		const base = listeners();
		const body = makeBody();
		body.exit(); // never entered
		expect(listeners()).toBe(base);
		let repaints = 0;
		// R14 / route B: the geometry has to actually CHANGE for the winch
		// to be a resize. It used to be two constants, and a same-size
		// winch used to repaint; now it deliberately emits nothing (the
		// terminal is already holding the right picture, and erasing its
		// scrollback to repaint an identical one is pure loss). What this
		// case is for — the handler is LIVE, not merely absent — is
		// unchanged; it just has to hand the handler a real resize.
		let W = 80;
		let H = 24;
		const watched = new Body({
			active: () => true,
			height: () => H,
			width: () => W,
			editCol: () => 1,
			write: () => {
				repaints += 1;
			},
		});
		watched.enter();
		vi.advanceTimersByTime(50); // a frame paints, so a geometry is on screen
		repaints = 0;
		W = 70;
		H = 20;
		process.stdout.emit("resize");
		// REL-0152-D18: a drag coalesces, so the repaint arrives once the
		// signals stop.
		vi.advanceTimersByTime(100);
		expect(repaints).toBeGreaterThan(0);
		watched.exit();
		watched.exit();
		expect(listeners()).toBe(base);
	});
});
