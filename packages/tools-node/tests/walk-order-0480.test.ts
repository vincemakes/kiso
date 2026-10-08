/**
 * 0.48.0 — a budgeted walk never starves a shallow file (finding 0472-F2).
 *
 * The owner asked kiso to edit a file on their Desktop. `list_dir {glob}`
 * missed it: the walk was depth-first in readdir order, and `Desktop/devv/`
 * sorts before `Desktop/generations.ts`. The walk spent the whole budget
 * (0.47.2's 20,000 visited files) inside devv's repositories, then stopped
 * before it looked one level down. 0.47.1 had no budget and found the file;
 * the 0.47.2 tests and its review used trees too small to reach the budget.
 * `search_text`'s own walk had the same shape since 0.26.2.
 *
 * Both walkers now go breadth-first: within a directory, entries are sorted
 * by name and the files are taken before any subdirectory is entered. What
 * the budget cuts is the deepest part of the tree. What they return is
 * sorted by path segments, so the listing reads the same whatever order
 * the filesystem's readdir returns.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { walkCorpus } from "../src/corpus.js";
import { listDirTool, searchTextTool } from "../src/index.js";

const ctx = () => ({ signal: new AbortController().signal });

function put(root: string, rel: string, text = "export {};\n"): void {
	const full = join(root, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
}

/** The owner's shape, small: `Desktop/` holds 20 project directories that
 *  sort before the file at its top, each with 10 files four levels down,
 *  and one more `generations.ts` deep inside project 3. */
function desktop(): string {
	const root = mkdtempSync(join(tmpdir(), "kiso-0480-walk-"));
	for (let d = 0; d < 20; d += 1) {
		for (let f = 0; f < 10; f += 1) put(root, `Desktop/d${String(d).padStart(2, "0")}/src/lib/f${f}.ts`);
	}
	put(root, "Desktop/generations.ts", "export const generations = 1;\n");
	put(root, "Desktop/d03/src/lib/generations.ts", "export const generations = 2;\n");
	return root;
}

/** mulberry32 — a seeded generator, so a red case replays */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A random tree: up to 5 levels, names drawn so that directories and
 *  files interleave in name order. Returns the root and every file. */
function randomTree(seed: number): { root: string; files: string[] } {
	const r = rng(seed);
	const root = mkdtempSync(join(tmpdir(), "kiso-0480-prop-"));
	const files: string[] = [];
	const grow = (rel: string, depth: number): void => {
		const n = 1 + Math.floor(r() * 4);
		for (let i = 0; i < n; i += 1) {
			const name = `${"abcdefghij"[Math.floor(r() * 10)]}${i}`;
			if (depth < 4 && r() < 0.45) grow(rel === "" ? name : `${rel}/${name}`, depth + 1);
			else {
				const file = `${rel === "" ? "" : `${rel}/`}${name}.ts`;
				put(root, file);
				files.push(file);
			}
		}
	};
	grow("", 0);
	return { root, files: [...new Set(files)] };
}

const depthOf = (rel: string): number => rel.split("/").length - 1;
const bySegments = (a: string, b: string): number => {
	const x = a.split("/");
	const y = b.split("/");
	for (let i = 0; i < Math.min(x.length, y.length); i += 1) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
	return x.length - y.length;
};

describe("0.48.0 — a budgeted walk never starves a shallow file", () => {
	it("list_dir's glob finds the file on the Desktop under a budget the projects beside it exhaust", async () => {
		const tool = listDirTool({ workspaceRoot: desktop(), limits: { searchMaxFiles: 100 } });
		const r = await tool.execute({ glob: "**/generations.ts" }, ctx());
		expect(r.isError).toBe(false);
		expect(r.content).toContain("Desktop/generations.ts");
		// the deep copy is within the first four project directories, inside the budget
		expect(r.content).toContain("Desktop/d03/src/lib/generations.ts");
		// the budget still stopped the walk, and it still says so
		expect(r.content).toContain("the walk stopped after 100 files — narrow the path");
	});

	it("search_text finds a word that only the shallow file holds, under the same budget", async () => {
		const root = desktop();
		put(root, "Desktop/notes.md", "the only line naming a starling\n");
		const r = await searchTextTool({ workspaceRoot: root, limits: { searchMaxFiles: 100 } }).execute({ pattern: "starling" }, ctx());
		expect(r.isError).toBe(false);
		expect(r.content).toContain("Desktop/notes.md:1:");
	});

	it("a budget of the files down to depth d returns exactly those files: 40 seeded trees", () => {
		for (let seed = 1; seed <= 40; seed += 1) {
			const { root, files } = randomTree(seed);
			const maxDepth = Math.max(...files.map(depthOf));
			for (let d = 0; d <= maxDepth; d += 1) {
				const want = files.filter((f) => depthOf(f) <= d).sort(bySegments);
				const got = walkCorpus({ workspaceRoot: root, maxVisited: want.length }).files;
				expect(got, `seed ${seed} depth ${d}`).toEqual(want);
			}
		}
	});

	it("an uncapped walk returns every file, sorted by path segments", () => {
		for (let seed = 41; seed <= 60; seed += 1) {
			const { root, files } = randomTree(seed);
			expect(walkCorpus({ workspaceRoot: root }).files, `seed ${seed}`).toEqual([...files].sort(bySegments));
		}
	});

	it("search_text lists its matches by path segments, then by line", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-0480-order-"));
		put(root, "z.ts", "kestrel\n");
		put(root, "a/x.ts", "kestrel one\nnothing\nkestrel two\n");
		put(root, "a-b.ts", "kestrel\n");
		const r = await searchTextTool({ workspaceRoot: root }).execute({ pattern: "kestrel" }, ctx());
		const paths = r.content.split("\n").map((l) => l.slice(0, l.indexOf(": ")));
		expect(paths).toEqual(["a/x.ts:1", "a/x.ts:3", "a-b.ts:1", "z.ts:1"]);
	});
});
