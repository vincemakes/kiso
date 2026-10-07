/**
 * Graphite §8.7 / §7.5 (R3b) — what waits for the person says so; a call
 * the person stopped says `interrupted`, not `denied`; compacting says why.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cellComponent, statusLine, visibleWidth, type BodyCell, type FrameCtx } from "../src/components.js";
import { compactingStatus } from "../src/status.js";
import { palette, setGround } from "../src/lines.js";

beforeAll(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => setGround("unknown"));

const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
const CTX: FrameCtx = { spinnerI: 0, now: 10_000, height: 24 };

describe("§8.7 — needs you", () => {
	it("a waiting status (`❯ …`) says `needs you` first, the `❯` gold; its own words after", () => {
		setGround("light");
		const p = palette();
		const row = statusLine("❯ run paused", "", 80, "");
		expect(plain(row)).toBe("❯ needs you · run paused");
		expect(row.startsWith(`${p.gold}❯${p.fgEnd}${p.dim}`)).toBe(true);
		expect(plain(statusLine("❯ a question for you", "", 80, ""))).toBe("❯ needs you · a question for you");
	});

	it("any other status is as it was", () => {
		setGround("light");
		const p = palette();
		expect(statusLine("▸ idle", "", 40, "")).toBe(`${p.dim}▸ idle${p.reset}`);
	});

	it("off a known ground the words are the same, one dim span", () => {
		setGround("unknown");
		const p = palette();
		expect(statusLine("❯ run paused", "", 80, "")).toBe(`${p.dim}❯ needs you · run paused${p.reset}`);
	});

	it("invariant ①: the waiting row fits, W 1..120, on both grounds and the unknown one", () => {
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (let W = 1; W <= 120; W += 1) expect(visibleWidth(statusLine("❯ your note goes to the model — it will propose a new call", "", W)), `${g} W=${W}`).toBeLessThanOrEqual(W);
		}
	});
});

describe("§7.5 — interrupted, not denied", () => {
	const cut = (over: Partial<Extract<BodyCell, { kind: "tool" }>>): string[] =>
		cellComponent({
			kind: "tool",
			name: "shell",
			input: "sleep 30",
			inputFull: JSON.stringify({ command: "sleep 30" }),
			childRoles: [],
			resultText: "tick 1\ntick 2",
			state: "done",
			isError: false,
			added: 0,
			removed: 0,
			startedAt: 0,
			doneAt: 3000,
			done: true,
			reason: "interrupted",
			verdict: null,
			expanded: false,
			diff: null,
			turn: 0,
			...over,
		} as Extract<BodyCell, { kind: "tool" }>).render(80, CTX);

	it("the card says `interrupted` on the machine's ground, its output so far below", () => {
		setGround("light");
		const p = palette();
		const rows = cut({});
		const text = rows.map(plain).join("\n");
		expect(text).toMatch(/SHELL sleep 30 +interrupted/);
		expect(text).not.toContain("denied");
		expect(text).toContain("tick 2");
		expect(rows[1]).toContain(p.washRun);
		expect(rows.join("")).not.toContain(p.washFail);
	});

	it("an approved call that was then stopped is still `interrupted`", () => {
		setGround("light");
		expect(cut({ verdict: { decision: "approved" } as never }).map(plain).join("\n")).toMatch(/interrupted/);
	});

	it("a refusal is still a refusal", () => {
		setGround("light");
		expect(cut({ reason: "not now", verdict: { decision: "denied" } as never }).map(plain).join("\n")).toMatch(/denied by you · not now/);
	});
});

describe("G7 — compacting says why", () => {
	it("the reason is the row's first fact; without one the row is as it was", () => {
		expect(compactingStatus("▘", 6, 95_100, 4, undefined, null, null, "manual")).toBe("▘ compacting · manual · 6 rounds · ~95.1k tokens · 4s");
		expect(compactingStatus("▘", 6, 95_100, 4, undefined, null, null, "auto")).toBe("▘ compacting · auto · 6 rounds · ~95.1k tokens · 4s");
		expect(compactingStatus("▘", 6, 95_100, 4)).toBe("▘ compacting · 6 rounds · ~95.1k tokens · 4s");
	});
});
