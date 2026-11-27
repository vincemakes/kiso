/**
 * ADR-0064 § 2.3 — the storage contract on both backends, and the file
 * backend's own discipline: CAS against the file, torn-tail repair, strict
 * load, a real cross-process lock.
 */
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendLogConformance } from "../src/conformance.js";
import { FileLogBackend } from "../src/file-log.js";
import { LogCorruptionError, StaleRevisionError } from "../src/log.js";
import { MemoryLogBackend } from "../src/memory-log.js";

const fresh = () => mkdtempSync(join(tmpdir(), "kiso-actor-log-"));

describe.each([
	["file", () => new FileLogBackend<{ n: number }>(fresh())],
	["memory", () => new MemoryLogBackend<{ n: number }>()],
])("the storage contract: %s backend", (_name, make) => {
	for (const check of appendLogConformance(make)) it(check.name, check.run);
});

describe("the file backend's discipline", () => {
	it("the CAS reads the file, not the writer's cache: a line that reached the file another way refuses the next append", async () => {
		const root = fresh();
		const b = new FileLogBackend<{ n: number }>(root);
		const w = await b.writer("a/work/x");
		await w.append(-1, { n: 0 });
		appendFileSync(join(root, "a/work/x.jsonl"), `${JSON.stringify({ seq: 1, ts: 0, event: { n: 1 } })}\n`);
		await expect(w.append(0, { n: 2 })).rejects.toBeInstanceOf(StaleRevisionError);
		await w.close();
	});

	it("a torn last line is cut back to the last newline; committed lines are never cut", async () => {
		const root = fresh();
		const b = new FileLogBackend<{ n: number }>(root);
		const w = await b.writer("a/work/x");
		await w.append(-1, { n: 0 });
		await w.append(0, { n: 1 });
		await w.close();
		const path = join(root, "a/work/x.jsonl");
		appendFileSync(path, `{"seq":2,"ts":0,"ev`);
		expect((await b.read("a/work/x")).length).toBe(2);
		const w2 = await b.writer("a/work/x");
		expect(w2.revision).toBe(1);
		await w2.append(1, { n: 2 });
		await w2.close();
		const text = readFileSync(path, "utf8");
		expect(text.split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { event: { n: number } }).event.n)).toEqual([0, 1, 2]);
	});

	it("load is strict: a damaged committed line, a seq gap, a non-object event each throw", async () => {
		const root = fresh();
		const b = new FileLogBackend<{ n: number }>(root);
		const path = join(root, "x.jsonl");
		for (const body of ["not json\n", `${JSON.stringify({ seq: 1, ts: 0, event: {} })}\n`, `${JSON.stringify({ seq: 0, ts: 0, event: 3 })}\n`]) {
			writeFileSync(path, body);
			await expect(b.read("x")).rejects.toBeInstanceOf(LogCorruptionError);
		}
	});

	it("log ids cannot leave the root", async () => {
		const b = new FileLogBackend(fresh());
		await expect(b.writer("../x")).rejects.toThrow(/invalid log id/);
		await expect(b.read("a//x")).rejects.toThrow(/invalid log id/);
	});
});
