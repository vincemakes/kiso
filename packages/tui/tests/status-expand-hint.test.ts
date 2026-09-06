/**
 * D-S2-1 (owner-ruled 2026-09-06) — the status row names the ctrl+o
 * SWITCH, and the per-card focus marker is gone.
 *
 * DC-50 made ctrl+o a global switch. The bright token on the newest live
 * card (TUI2-R2 ⑤) had been "the cell the next press will act on"; with
 * every card acted on at once there was no target left to mark, and a
 * marker that singles one card out reads as "only this one". The hint
 * moves to where every other key hint lives — the idle hint on the
 * status row — and says which way the switch will go. It appears only
 * while some committed card has something behind the key: a hint for a
 * key that would change nothing is a hint that lies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { COLOR_ON } from "../src/lines.js";
import { Screen } from "./helpers/screen.js";

beforeEach(() => {
	vi.useFakeTimers();
	delete process.env.NO_COLOR;
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => {
	vi.useRealTimers();
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

function makeBody(opts: { W?: number; H?: number } = {}) {
	const W = opts.W ?? 80;
	const H = opts.H ?? 24;
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	const statusRow = (): string => {
		const sc = new Screen(W, H);
		sc.feed(writes.join(""));
		return sc.rows[H - 1]!.join("").replace(/\s+$/, "");
	};
	const rows = (): string[] => {
		const sc = new Screen(W, H);
		sc.feed(writes.join(""));
		return sc.rows.map((r) => r.join("").replace(/\s+$/, ""));
	};
	return { body, writes, statusRow, rows, tick: () => vi.advanceTimersByTime(16) };
}

const call = (body: Body, name: string, id: string, input: Record<string, unknown>, out: string): void => {
	body.toolStart(name, id, input);
	body.toolRunning(id);
	body.toolResult(id, { content: out, isError: false });
};

const TWELVE = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");

function settled(W = 80) {
	const t = makeBody({ W });
	t.body.enter();
	t.body.userLine("run it");
	call(t.body, "shell", "s1", { command: "npm test" }, TWELVE);
	t.body.textAppend("done.\n");
	t.body.textEnd();
	t.body.endTurn(0);
	t.tick();
	return t;
}

describe("D-S2-1 — the status row names the switch", () => {
	it("a committed card with a cut: the idle hint says `ctrl+o expand all`", () => {
		const { statusRow } = settled();
		expect(statusRow()).toContain("ctrl+o expand all");
		expect(statusRow()).toContain("/ commands");
	});

	it("after the switch flips, the same rung says `collapse all`", () => {
		const { body, statusRow, tick } = settled();
		body.toggleExpanded();
		tick();
		expect(statusRow()).toContain("ctrl+o collapse all");
		expect(statusRow()).not.toContain("expand all");
	});

	it("a bodiless READ card still hides its lines behind the key (R13 E1), so the rung shows", () => {
		const t = makeBody();
		t.body.enter();
		t.body.userLine("read it");
		call(t.body, "read_file", "r1", { path: "a.ts" }, "x");
		t.body.textAppend("done.\n");
		t.body.textEnd();
		t.body.endTurn(0);
		t.tick();
		expect(t.statusRow()).toContain("ctrl+o expand all");
	});

	it("no card has anything behind the key: no ctrl+o on the status row at all", () => {
		const t = makeBody();
		t.body.enter();
		t.body.userLine("touch it");
		call(t.body, "write_file", "w1", { path: "a.ts" }, ""); // an empty result hides nothing
		t.body.textAppend("done.\n");
		t.body.textEnd();
		t.body.endTurn(0);
		t.tick();
		expect(t.statusRow()).toContain("/ commands");
		expect(t.statusRow()).not.toContain("ctrl+o");
	});

	it("the rung gives way with the width — the ladder's shorter forms are unchanged", () => {
		const { statusRow } = settled(40);
		expect(statusRow()).toContain("/ commands");
		expect(statusRow()).not.toContain("ctrl+o");
	});

	it("no row anywhere wears the retired bright token", () => {
		const { writes } = settled();
		expect(writes.join("")).not.toContain("\x1b[22m\x1b[39m\x1b[1m");
		expect(COLOR_ON).not.toHaveProperty("lift");
	});
});
