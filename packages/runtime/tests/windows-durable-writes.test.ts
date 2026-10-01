/**
 * Windows P3 — the durable writes work under Windows' file rules.
 *
 * On Windows a handle opened for append can be neither flushed nor
 * truncated (FlushFileBuffers and SetEndOfFile need the write access that
 * append mode drops: EPERM), and no directory opens as a file. The first
 * Windows CI run hit the first rule 195 times — the session store's
 * per-event fsync — and the second three times (the torn-tail repair).
 *
 * This file imposes those three rules on the real disk under `node:fs`,
 * with `process.platform` set to "win32", and drives the session store,
 * the task journal and the profile writer through them. It runs on every
 * OS; the Windows CI runs the real thing.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rules = vi.hoisted(() => ({ on: false, appendFds: new Set<number>(), syncs: 0 }));

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const appendMode = (flags: unknown): boolean =>
		(typeof flags === "string" && flags.startsWith("a")) || (typeof flags === "number" && (flags & real.constants.O_APPEND) !== 0);
	const eperm = (syscall: string): Error => Object.assign(new Error(`EPERM: operation not permitted, ${syscall}`), { code: "EPERM", syscall });
	return {
		...real,
		openSync: (path: unknown, flags?: unknown, mode?: unknown) => {
			if (rules.on && typeof path === "string" && real.existsSync(path) && real.statSync(path).isDirectory()) {
				throw Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${path}'`), { code: "EISDIR" });
			}
			const fd = (real.openSync as (...a: unknown[]) => number)(path, flags, mode);
			if (appendMode(flags)) rules.appendFds.add(fd);
			else rules.appendFds.delete(fd);
			return fd;
		},
		fsyncSync: (fd: number) => {
			if (rules.on && rules.appendFds.has(fd)) throw eperm("fsync");
			rules.syncs += 1;
			return real.fsyncSync(fd);
		},
		ftruncateSync: (fd: number, len?: number) => {
			if (rules.on && rules.appendFds.has(fd)) throw eperm("ftruncate");
			return real.ftruncateSync(fd, len);
		},
	};
});

const { SessionStore } = await import("../src/store.js");
const { appendRecord, fsyncDir } = await import("../src/tasks/journal.js");
const { writeProfile, readProfile } = await import("../src/profile.js");

const realPlatform = process.platform;
beforeEach(() => {
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	rules.on = true;
	rules.syncs = 0;
});
afterEach(() => {
	rules.on = false;
	Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("under Windows' file rules", () => {
	it("the session store appends, syncs, and reads back every record", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-win-store-")));
		await store.append("s", "r1", { seq: 0, type: "user_input", content: "go" } as never);
		await store.append("s", "r1", { seq: 1, type: "text_delta", text: "do" } as never);
		await store.append("s", "r1", { seq: 2, type: "stop", reason: "end_turn" } as never);
		store.closeAll();
		expect(rules.syncs).toBeGreaterThanOrEqual(2);
		expect(new SessionStore(store.root).load("s").map((r) => r.event.type)).toEqual(["user_input", "text_delta", "stop"]);
	});

	it("the store repairs a torn final line (the truncate) and appends after it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-win-torn-"));
		const first = new SessionStore(dir);
		await first.append("s", "r1", { seq: 0, type: "user_input", content: "go" } as never);
		first.closeAll();
		const file = join(dir, "s.jsonl");
		writeFileSync(file, `${readFileSync(file, "utf8")}{"runId":"r1","ev`);
		const store = new SessionStore(dir);
		await store.append("s", "r1", { seq: 1, type: "stop", reason: "end_turn" } as never);
		store.closeAll();
		expect(new SessionStore(dir).load("s").map((r) => r.event.seq)).toEqual([0, 1]);
	});

	it("the task journal appends and syncs a record; a directory sync does not throw", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-win-journal-"));
		const file = join(dir, "journal.jsonl");
		appendRecord(file, { type: "stop_requested", ts: 1, by: "person" });
		appendRecord(file, { type: "stop_requested", ts: 2, by: "model" });
		expect(rules.syncs).toBe(2);
		expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
		expect(() => fsyncDir(dir)).not.toThrow();
	});

	it("the profile is written durably and reads back", () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-win-profile-"));
		const profile = { schema: 1, model: "faux" } as never;
		expect(() => writeProfile(root, "s", profile)).not.toThrow();
		expect(readProfile(root, "s")).toBeDefined();
	});
});
