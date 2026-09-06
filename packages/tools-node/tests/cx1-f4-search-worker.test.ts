/**
 * CX-1 F4 — search behind a killable boundary.
 *
 * `search_text` ran a model-supplied regex synchronously per line; a
 * catastrophic pattern blocked the event loop, and no budget check,
 * timer or abort could run (audit F4 — `(a+)+$` on 33 characters
 * needed an external kill). The walk-and-match now runs in a Worker the
 * main thread can TERMINATE: the deadline and the abort both kill it.
 *
 * Acceptance is not "it is isolated": the gates prove the call returns
 * within its budget (finite tolerance), the main thread stays live
 * during the hang, abort lands promptly, and repeated timeouts leave no
 * thread behind and no unbounded growth.
 *
 * The fixture uses 28 characters — exponential enough (~1 s of
 * backtracking) to show the old blocking, small enough that the RED run
 * finishes instead of hanging the suite.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { searchTextTool, searchWorkerStats } from "../src/index.js";

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-cx1-f4-"));
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "src", "evil.txt"), `${"a".repeat(28)}!\n`, "utf8");
	writeFileSync(join(dir, "src", "plain.txt"), "hello world\nneedle here\n", "utf8");
	return dir;
}

const ctx = (signal?: AbortSignal) => ({ signal: signal ?? new AbortController().signal });
const EVIL = "(a+)+$";

describe("CX-1 F4 — the search boundary", () => {
	it("(a) a catastrophic pattern returns within searchMaxMs + 250 ms, with the budget note", async () => {
		const tool = searchTextTool({ workspaceRoot: workspace(), limits: { searchMaxMs: 100 } });
		const t0 = Date.now();
		const r = await tool.execute({ pattern: EVIL }, ctx());
		expect(Date.now() - t0).toBeLessThan(100 + 250);
		expect(r.content).toMatch(/budget|stopped/i);
	});

	it("(b) the main thread stays live during the hang: a 50 ms timer fires before the call returns", async () => {
		const tool = searchTextTool({ workspaceRoot: workspace(), limits: { searchMaxMs: 400 } });
		let fired = -1;
		const t0 = Date.now();
		setTimeout(() => {
			fired = Date.now() - t0;
		}, 50);
		await tool.execute({ pattern: EVIL }, ctx());
		expect(fired).toBeGreaterThanOrEqual(0);
		expect(fired).toBeLessThan(300); // it fired DURING the search, not after the loop was freed
	});

	it("(c) abort mid-hang returns within 500 ms of the abort", async () => {
		const tool = searchTextTool({ workspaceRoot: workspace(), limits: { searchMaxMs: 10_000 } });
		const controller = new AbortController();
		const t0 = Date.now();
		setTimeout(() => controller.abort(), 100);
		const r = await tool.execute({ pattern: EVIL }, ctx(controller.signal));
		expect(Date.now() - t0).toBeLessThan(100 + 500);
		expect(r.isError).toBe(true);
		expect(r.content).toMatch(/abort/i);
	});

	it("(d) twenty consecutive timeouts leave no live worker and no unbounded growth", async () => {
		const tool = searchTextTool({ workspaceRoot: workspace(), limits: { searchMaxMs: 30 } });
		const rss0 = process.memoryUsage().rss;
		for (let i = 0; i < 20; i += 1) await tool.execute({ pattern: EVIL }, ctx());
		await new Promise((r) => setTimeout(r, 200));
		expect(searchWorkerStats().alive).toBe(0);
		expect(process.memoryUsage().rss - rss0).toBeLessThan(50 * 1024 * 1024);
	});

	it("(e) an ordinary search still finds its match, with the startup cost measured", async () => {
		const tool = searchTextTool({ workspaceRoot: workspace() });
		const t0 = Date.now();
		const r = await tool.execute({ pattern: "needle" }, ctx());
		const wall = Date.now() - t0;
		expect(r.content).toContain("plain.txt:2");
		expect(wall).toBeLessThan(1000);
		// eslint-disable-next-line no-console
		console.log(`[cx1-f4] per-call worker wall: ${wall} ms`);
	});
});
