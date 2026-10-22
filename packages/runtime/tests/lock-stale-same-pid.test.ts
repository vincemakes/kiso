/**
 * A lock left by a killed process that had OUR pid is stale, not a
 * same-process writer's residue.
 *
 * In a container the node process is pid 1. A container killed with
 * SIGKILL leaves `{pid: 1, token: <old>}`; the next container's node is pid 1
 * too, so `isAlive(1)` is true and the old rule read the file as "another
 * store in THIS process" and retried 25 times before refusing — for ever,
 * every message, "locked by another writer". The fix: a lock naming our pid
 * is same-process residue only when its TOKEN belongs to a handle this
 * process still holds; any other token is a previous process's and is taken
 * over like a dead holder.
 *
 * red: the first test fails against the old rule (LockedError after ~0.5 s).
 * green: the takeover proceeds; the live same-process holder is still
 * waited for (second test) and still refused after the retry (third).
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LockedError, nativeLockAdapter } from "../src/lock-adapter.js";

const noCancel = (): void => {};
const lockIn = (): string => join(mkdtempSync(join(tmpdir(), "kiso-stale-pid-")), "s.lock");

describe("a lock left by a previous process with our pid", () => {
	it("is taken over: a token this process never issued is stale", async () => {
		const lockPath = lockIn();
		writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "left-by-a-killed-container" }), "utf8");
		const t0 = Date.now();
		const handle = await nativeLockAdapter.acquire(lockPath, "s", noCancel);
		expect(Date.now() - t0, "no retry loop: the takeover is immediate").toBeLessThan(300);
		expect(handle.verify()).toBe(true);
		expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe(handle.token);
		handle.release();
	});

	it("never steals a lock a live handle of this process holds: the contender waits for the release", async () => {
		const lockPath = lockIn();
		const a = await nativeLockAdapter.acquire(lockPath, "s", noCancel);
		const b = nativeLockAdapter.acquire(lockPath, "s", noCancel);
		await new Promise((r) => setTimeout(r, 100));
		expect(a.verify(), "A still owns it while B waits").toBe(true);
		a.release();
		const handleB = await b;
		expect(handleB.verify()).toBe(true);
		handleB.release();
	});

	it("still refuses a live same-process holder that does not release (the retry budget is unchanged)", async () => {
		const lockPath = lockIn();
		const a = await nativeLockAdapter.acquire(lockPath, "s", noCancel);
		await expect(nativeLockAdapter.acquire(lockPath, "s", noCancel)).rejects.toBeInstanceOf(LockedError);
		expect(a.verify()).toBe(true);
		a.release();
	}, 30_000);

	it("a released handle's token is no longer 'ours': its residue is taken over too", async () => {
		const lockPath = lockIn();
		const a = await nativeLockAdapter.acquire(lockPath, "s", noCancel);
		const staleIdentity = JSON.stringify({ pid: process.pid, token: a.token });
		a.release();
		// a crashed-then-restarted same-pid process leaves exactly this file
		writeFileSync(lockPath, staleIdentity, "utf8");
		const t0 = Date.now();
		const b = await nativeLockAdapter.acquire(lockPath, "s", noCancel);
		expect(Date.now() - t0).toBeLessThan(300);
		b.release();
	});
});
