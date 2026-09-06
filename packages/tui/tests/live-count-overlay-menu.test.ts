/**
 * S4 D-S4-1 — liveCount() measures what the SCREEN gets under an
 * overlay.
 *
 * The menu band is chrome, and the frame's own arithmetic has always
 * counted it whatever occupies the live region. The old scalar added
 * the band on the projection branch only, so with the keys sheet up and
 * a menu open it under-counted by the band's height — a scalar that
 * disagreed with the screen, which is the disagreement DC-27 exists to
 * forbid. Red on the old scalar: the last assertion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body, type InputState } from "../src/compositor.js";

const one = (line: string): (() => InputState) => () => ({ line, cursor: line.length });

function count(opts: { sheet: boolean; menu: boolean }): number {
	const body = new Body({ active: () => true, height: () => 24, width: () => 80, editCol: () => 1, write: () => {} });
	body.bindInput(one("/mo"), "› ");
	body.bindSheet(() => opts.sheet);
	body.bindMenu(() => (opts.menu ? { items: [{ name: "/mode", desc: "switch the approval tier" }], selected: 0 } : null));
	return body.liveCount();
}

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

describe("S4 D-S4-1 — the scalar counts the menu band under an overlay", () => {
	it("the menu band costs the same rows under the keys sheet as under the projection", () => {
		const band = count({ sheet: false, menu: true }) - count({ sheet: false, menu: false });
		expect(band).toBeGreaterThan(0);
		expect(count({ sheet: true, menu: false })).toBeGreaterThan(count({ sheet: false, menu: false })); // the sheet occupies the region
		expect(count({ sheet: true, menu: true }) - count({ sheet: true, menu: false })).toBe(band);
	});
});
