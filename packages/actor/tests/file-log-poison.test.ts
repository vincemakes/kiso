/**
 * A failed fsync poisons the writer: every later append is refused with the
 * cause, never a misleading StaleRevisionError, and a fresh writer recovers.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const failNext = vi.hoisted(() => ({ fsync: false }));

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		fsync: (fd: number, cb: (error: NodeJS.ErrnoException | null) => void) => {
			if (failNext.fsync) {
				failNext.fsync = false;
				cb(Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }));
				return;
			}
			fs.fsync(fd, cb);
		},
	};
});

const { FileLogBackend } = await import("../src/file-log.js");
const { LogPoisonedError } = await import("../src/log.js");

describe("a failed fsync poisons the writer", () => {
	it("refuses every later append with the cause, and a new writer carries on from the file", async () => {
		const b = new FileLogBackend<{ n: number }>(mkdtempSync(join(tmpdir(), "kiso-actor-poison-")));
		const w = await b.writer("a/work/x");
		await w.append(-1, { n: 0 });
		failNext.fsync = true;
		await expect(w.append(0, { n: 1 })).rejects.toBeInstanceOf(LogPoisonedError);
		await expect(w.append(0, { n: 2 })).rejects.toThrow(/poisoned by a failed write: EIO/);
		await expect(w.append(1, { n: 2 })).rejects.toBeInstanceOf(LogPoisonedError);
		await w.close();
		const w2 = await b.writer("a/work/x");
		expect(w2.revision).toBe(1);
		await w2.append(1, { n: 2 });
		await w2.close();
	});
});
