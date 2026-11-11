/** load() reads only what was appended since the last load, and falls back to the strict whole read whenever the file is
 *  anything but the same file grown. Each case is one a cached read must never hide. */

import { appendFileSync, mkdtempSync, readFileSync, renameSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore, StoreCorruptionError } from "../src/store.js";

const line = (seq: number, runId = "r") => `${JSON.stringify({ runId, ts: 1000 + seq, event: { seq, type: "text_delta", text: `t${seq}` } })}\n`;
function world(n = 3) {
	const root = mkdtempSync(join(tmpdir(), "kiso-lc-"));
	const path = join(root, "s.jsonl");
	writeFileSync(path, Array.from({ length: n }, (_, i) => line(i)).join(""));
	return { store: new SessionStore(root), path };
}

describe("load's tail read", () => {
	it("an append by another writer is seen, and each caller gets its own array", () => {
		const { store, path } = world();
		const a = store.load("s");
		appendFileSync(path, line(3) + line(4));
		const b = store.load("s");
		expect(b.map((r) => r.event.seq)).toEqual([0, 1, 2, 3, 4]);
		expect(a).toHaveLength(3);
		b.push(b[0]!);
		expect(store.load("s")).toHaveLength(5);
	});

	it("a torn tail is not returned, and is read once it is completed", () => {
		const { store, path } = world();
		store.load("s");
		const next = line(3);
		appendFileSync(path, next.slice(0, 10));
		expect(store.load("s")).toHaveLength(3);
		appendFileSync(path, next.slice(10));
		expect(store.load("s")).toHaveLength(4);
	});

	it("a shorter file is read whole, so damage still throws", () => {
		const { store, path } = world();
		store.load("s");
		truncateSync(path, readFileSync(path).length - 5);
		expect(store.load("s")).toHaveLength(2); // the cut line is a torn tail
		writeFileSync(path, line(0) + "garbage\n" + line(2));
		expect(() => store.load("s")).toThrow(StoreCorruptionError);
	});

	it("a file replaced by another (a new inode) is read whole", () => {
		const { store, path } = world();
		store.load("s");
		writeFileSync(`${path}.new`, line(0));
		renameSync(`${path}.new`, path);
		expect(store.load("s")).toHaveLength(1);
	});

	it("the same size with a new mtime is read whole", () => {
		const { store, path } = world();
		store.load("s");
		const bytes = readFileSync(path, "utf8").replace("t1", "x1");
		writeFileSync(path, bytes);
		utimesSync(path, new Date(), new Date(Date.now() + 5000));
		expect((store.load("s")[1]!.event as { text: string }).text).toBe("x1");
	});

	it("a bad appended line or a seq gap falls back to the strict read, which refuses it", () => {
		const { store, path } = world();
		store.load("s");
		appendFileSync(path, line(5));
		expect(() => store.load("s")).toThrow(/seq discontinuity/);
		const w = world();
		w.store.load("s");
		appendFileSync(w.path, "{not json}\n");
		expect(() => w.store.load("s")).toThrow(StoreCorruptionError);
	});

	it("a deleted log loads empty and starts over", () => {
		const { store, path } = world();
		store.load("s");
		renameSync(path, `${path}.gone`);
		expect(store.load("s")).toEqual([]);
		writeFileSync(path, line(0));
		expect(store.load("s")).toHaveLength(1);
	});
});
