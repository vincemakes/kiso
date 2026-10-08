/**
 * 0.47.2 — `list_dir` with a glob walks off the main thread (the owner's
 * trace, 2026-10-08).
 *
 * `list_dir {"path": ".", "glob": "**\/flowpix*"}` from a home directory
 * walked synchronously on the main thread for 11.02 s: no frame, no timer,
 * no esc reached kiso until it returned, and the working row's mark stood
 * still. `search_text` had moved its walk into the search worker (CX-1 F4)
 * with a file cap and a deadline; the glob walk had neither. It now runs
 * in the same worker, under the same budget, and says where it stopped.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { walkCorpus, globToRegExp } from "../src/corpus.js";
import { listDirTool, searchWorkerStats } from "../src/index.js";

function tree(dirs: number, filesPerDir: number): string {
	const root = mkdtempSync(join(tmpdir(), "kiso-0472-glob-"));
	for (let d = 0; d < dirs; d += 1) {
		const sub = join(root, `proj${String(d).padStart(3, "0")}`, "src");
		mkdirSync(sub, { recursive: true });
		for (let f = 0; f < filesPerDir; f += 1) writeFileSync(join(sub, `file${String(f).padStart(3, "0")}.ts`), "export {};\n");
	}
	writeFileSync(join(root, "proj000", "flowpix-notes.md"), "# notes\n");
	return root;
}

const ctx = (signal?: AbortSignal) => ({ signal: signal ?? new AbortController().signal });

describe("0.47.2 — list_dir's glob walk runs off the main thread", () => {
	it("the call hands the walk to the search worker: one in flight while it runs", async () => {
		const tool = listDirTool({ workspaceRoot: tree(4, 5) });
		const before = searchWorkerStats().inFlight;
		const pending = tool.execute({ glob: "**/flowpix*" }, ctx());
		// a synchronous walk has finished by the time execute returns its
		// promise; a walk on the worker is still in flight here
		expect(searchWorkerStats().inFlight).toBe(before + 1);
		const r = await pending;
		expect(r.content).toContain("proj000/flowpix-notes.md");
		expect(searchWorkerStats().inFlight).toBe(before);
	});

	it("the main thread stays live: a timer fires before the call returns", async () => {
		const tool = listDirTool({ workspaceRoot: tree(30, 100) });
		let ticks = 0;
		const timer = setInterval(() => (ticks += 1), 1);
		let atReturn = -1;
		await tool.execute({ glob: "**/nothing-matches-this*" }, ctx()).then(() => (atReturn = ticks));
		clearInterval(timer);
		// a synchronous walk resolves in the microtask after it returns, before
		// any timer can run: it would read 0
		expect(atReturn).toBeGreaterThan(0);
	});

	it("the walk stops after limits.searchMaxFiles files, and says so", async () => {
		const tool = listDirTool({ workspaceRoot: tree(8, 5), limits: { searchMaxFiles: 10 } });
		const r = await tool.execute({ glob: "**/nothing-matches-this*" }, ctx());
		expect(r.isError).toBe(false);
		expect(r.content).toContain("(no match for **/nothing-matches-this*)");
		expect(r.content).toContain("the walk stopped after 10 files — narrow the path");
	});

	it("a walk past its budget returns within searchMaxMs + 250 ms, with the budget note", async () => {
		const tool = listDirTool({ workspaceRoot: tree(40, 100), limits: { searchMaxMs: 1 } });
		const t0 = Date.now();
		const r = await tool.execute({ glob: "**/nothing-matches-this*" }, ctx());
		expect(Date.now() - t0).toBeLessThan(1 + 250);
		expect(r.content).toMatch(/the walk stopped — its budget elapsed/);
	});

	it("an abort returns at once, as an error", async () => {
		const tool = listDirTool({ workspaceRoot: tree(10, 20) });
		const ac = new AbortController();
		const pending = tool.execute({ glob: "**/*.ts" }, ctx(ac.signal));
		ac.abort();
		const r = await pending;
		expect(r.isError).toBe(true);
		expect(r.content).toBe("list_dir aborted");
	});

	it("an ordinary glob lists what the walk on the main thread listed, in its order, with its notes", async () => {
		const root = tree(3, 4);
		const tool = listDirTool({ workspaceRoot: root });
		const r = await tool.execute({ glob: "**/*.ts" }, ctx());
		const expected = walkCorpus({ workspaceRoot: root, maxEntries: 200, accept: (rel) => globToRegExp("**/*.ts").test(rel) }).files;
		expect(r.content.split("\n")).toEqual(expected);
		const capped = await listDirTool({ workspaceRoot: tree(30, 10) }).execute({ glob: "**/*.ts" }, ctx());
		expect(capped.content).toContain("… 200 shown (narrow the pattern for more)");
	});
});
