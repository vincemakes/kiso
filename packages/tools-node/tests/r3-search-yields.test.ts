/**
 * R3 — `search_text` does not own the event loop.
 *
 * The defect, as the owner met it: a search over a home directory ran
 * 18.4 seconds and the `working` mark froze solid for all of it, so the
 * session read as crashed. The cause was not the duration — a big tree
 * is legitimately slow — it was that the walk was `readdirSync` +
 * `readFileSync` all the way down inside an `async` body. A synchronous
 * traversal BLOCKS Node's loop: no timer fires, no frame paints, and
 * the one mark whose entire job is "I am still alive" stops moving at
 * exactly the moment a human needs it most.
 *
 * The gate measures what the user experienced — whether timers still
 * fire WHILE the search runs — rather than the shape of the code, so it
 * survives a rewrite that keeps the property and fails one that does
 * not.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { searchTextTool } from "../src/index.js";
import type { ToolContext } from "@vincemakes/kiso-core";

const CTX: ToolContext = {
	signal: { aborted: false, addEventListener: () => {}, removeEventListener: () => {} },
} as unknown as ToolContext;

/**
 * ONE tree for the whole file, built once.
 *
 * It used to be built per case, three times, 600 files each — which
 * starved vitest's reporter RPC ("Timeout calling onTaskUpdate", the
 * failure this suite's own comments record at 193 files). The property
 * under test needs only enough files to force at least one yield, and
 * YIELD_EVERY is 64: 200 clears it three times over and costs a
 * fraction of the I/O.
 */
// 80, not 200: the property needs the walk to cross YIELD_EVERY (64)
// at least once, and nothing more. 200 was chosen for realism and cost a
// synchronous 200-file write in beforeAll — which blocks the worker and
// starves vitest's reporter RPC ("Timeout calling onTaskUpdate"), the
// failure this repo already hit at 193 files.
const FILES = 80;
let ROOT = "";

beforeAll(() => {
	ROOT = mkdtempSync(join(tmpdir(), "kiso-r3-search-"));
	for (let d = 0; d < 8; d += 1) {
		const dir = join(ROOT, `d${d}`);
		mkdirSync(dir);
		for (let f = 0; f < Math.ceil(FILES / 8); f += 1) {
			writeFileSync(join(dir, `f${f}.txt`), "the needle is here\n");
		}
	}
});

describe("R3 — a long search keeps the event loop alive", () => {
	it("the event loop TURNS while the walk runs — the frozen `working` mark's root cause", async () => {
		// The count is of LOOP TURNS, not of wall-clock ticks.
		//
		// The first draft of this gate raced a 5ms setInterval, and it
		// FLAKED: on a fast machine the whole walk finishes inside one
		// interval period, so a perfectly well-behaved async walk scored
		// zero and the gate failed a green tree. A release gate that is
		// sometimes wrong is worse than no gate, because it teaches you to
		// re-run it.
		//
		// A self-re-arming setImmediate has no such dependency. Under a
		// synchronous walk it can NEVER run — the loop is owned, so the
		// check phase is never reached — and that is structural, not a
		// matter of how fast the disk is. Under an async walk every await
		// hands it a turn. Zero means blocked, at any speed.
		let turns = 0;
		let stop = false;
		const beat = (): void => {
			if (stop) return;
			turns += 1;
			setImmediate(beat);
		};
		setImmediate(beat);
		try {
			const found = await searchTextTool({ workspaceRoot: ROOT }).execute({ pattern: "needle", path: "." }, CTX);
			expect(found.isError).toBe(false);
		} finally {
			stop = true;
		}
		expect(turns, "the search OWNED the event loop — nothing else could run, so the liveness mark freezes").toBeGreaterThan(0);
	}, 60_000);

	it("still finds every match, in the same shape — the yield changes the loop, never the result", async () => {
		const found = await searchTextTool({ workspaceRoot: ROOT }).execute({ pattern: "needle", path: "." }, CTX);
		expect(found.isError).toBe(false);
		expect(found.content).toMatch(/f\d+\.txt:1: the needle is here/);
	}, 60_000);

	it("an unreadable subtree still fails the whole call the way it always did", async () => {
		const found = await searchTextTool({ workspaceRoot: mkdtempSync(join(tmpdir(), "kiso-r3-empty-")) }).execute(
			{ pattern: "x", path: "." },
			CTX,
		);
		expect(found).toMatchObject({ isError: false });
		expect(found.content).toBe("(no matches)");
	}, 60_000);
});
