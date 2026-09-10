/**
 * DC-59 (0.32.2) — under tmux without `mouse on`, kiso says so once at start.
 *
 * The owner's 0.32.1 dogfood, confirmed under tmux: trackpad scrolling
 * after a run walked the composer's history. TMUX-F1's mechanism — the
 * terminal turns the wheel into arrow keys for tmux's alternate screen and
 * tmux passes them on — and the burst guard's limit: it collapses a wheel
 * NOTCH (three or more arrows in one read), not a smooth trackpad stream
 * that arrives one arrow per read. kiso cannot tell those arrows from a
 * hand; what it can do is name the cause where it is known: `$TMUX` set and
 * tmux's `mouse` option off. With `mouse on` tmux owns the wheel and kiso
 * receives nothing (measured, kiso-doc/kiso-finding-tmux-wheel-2026-09-10.md).
 */
import { describe, expect, it } from "vitest";
import { TMUX_MOUSE_HINT, tmuxMouseHint } from "../src/tmux-hint.js";

describe("DC-59 — the tmux mouse hint", () => {
	it("outside tmux: nothing, and tmux is never asked", () => {
		let asked = 0;
		expect(tmuxMouseHint({}, () => { asked += 1; return "off"; })).toBeNull();
		expect(asked).toBe(0);
	});
	it("under tmux with mouse off: the hint, naming the setting", () => {
		expect(tmuxMouseHint({ TMUX: "/tmp/tmux-501/default,123,0" }, () => "off")).toBe(TMUX_MOUSE_HINT);
		expect(TMUX_MOUSE_HINT).toContain("set -g mouse on");
	});
	it("under tmux with mouse on: nothing", () => {
		expect(tmuxMouseHint({ TMUX: "/tmp/tmux-501/default,123,0" }, () => "on")).toBeNull();
	});
	it("under tmux but the option cannot be read: nothing, never a guess", () => {
		expect(tmuxMouseHint({ TMUX: "/tmp/tmux-501/default,123,0" }, () => null)).toBeNull();
	});
});
