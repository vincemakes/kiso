/**
 * The session log's per-event sync runs on the thread pool (owner, 2026-11-25; kiso-doc plan-runtime-fsync-b-onepage-2026-11-25), and the
 * writer lock covers the durability boundary, not only the write. Pinned here, with an fsync the test settles by hand (no wall clock):
 *
 * 1. an append resolves only after its own sync settles, and the event loop runs meanwhile;
 * 2. one session: one sync at a time, in order; two sessions: their syncs overlap;
 * 3. a sync pending, then close(): the lock is not released early, close() settles after the sync;
 * 4. A's sync fails: nothing is appended behind it on the instance, and no other store takes the lock meanwhile;
 * 5. close() settles, then a fresh store takes the session at once and reads the whole durable prefix;
 * 6. close() settles, then the files are removed: no fs operation touches them afterwards;
 * A. an append still waiting for a foreign lock: close() settles only after it refused, and nothing it acquired survives;
 * B. cleanup is unconditional: one session's sync fails during closeAll, every session is still closed and unlocked, and closeAll rejects;
 * C. concurrent close() calls coalesce: one barrier, one fd close, one release;
 * (7., the kill -9 writer, is store-async-fsync-kill9.test.ts: it spawns a process, so it runs in the PTY pool; this file stays in the unit
 * pool so the Windows job runs 6., close-then-delete.)
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ctl = vi.hoisted(() => ({
	manual: false,
	pending: [] as { fd: number; cb: (error: NodeJS.ErrnoException | null) => void }[],
	track: false,
	ops: [] as string[],
	closes: new Map<number, number>(),
	watchIno: null as number | null,
	watchedCloses: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const note = (op: string): void => void (ctl.track && ctl.ops.push(op));
	return {
		...real,
		fsync: (fd: number, cb: (error: NodeJS.ErrnoException | null) => void) => {
			note(`fsync ${fd}`);
			if (ctl.manual) ctl.pending.push({ fd, cb });
			else real.fsync(fd, cb);
		},
		fsyncSync: (fd: number) => (note(`fsyncSync ${fd}`), real.fsyncSync(fd)),
		closeSync: (fd: number) => {
			note(`closeSync ${fd}`);
			ctl.closes.set(fd, (ctl.closes.get(fd) ?? 0) + 1);
			if (ctl.watchIno !== null && real.fstatSync(fd).ino === ctl.watchIno) ctl.watchedCloses += 1; // a close of the watched file, whatever fd number it has
			return real.closeSync(fd);
		},
		appendFileSync: (...a: unknown[]) => (note("appendFileSync"), (real.appendFileSync as (...x: unknown[]) => void)(...a)),
		openSync: (...a: unknown[]) => (note(`openSync ${String(a[0])}`), (real.openSync as (...x: unknown[]) => number)(...a)),
	};
});

const { SessionStore } = await import("../src/store.js");

const ev = (seq: number) => ({ seq, type: "stop" as const, reason: "end_turn" as const });
const dir = (): string => mkdtempSync(join(tmpdir(), "kiso-async-fsync-"));
const turn = (): Promise<void> => new Promise((r) => setImmediate(r));
async function until(cond: () => boolean, turns = 2000): Promise<void> {
	for (let i = 0; i < turns && !cond(); i++) await turn();
	if (!cond()) throw new Error("condition not reached");
}
const settle = (error: NodeJS.ErrnoException | null = null): void => ctl.pending.shift()!.cb(error);
const lockText = (root: string, id: string): string => readFileSync(join(root, `${id}.lock`), "utf8");
const state = (p: Promise<unknown>): { done: boolean; failed: unknown } => {
	const s = { done: false, failed: undefined as unknown };
	p.then(
		() => void (s.done = true),
		(e: unknown) => void ((s.done = true), (s.failed = e)),
	);
	return s;
};

afterEach(() => {
	ctl.manual = false;
	while (ctl.pending.length > 0) settle();
	ctl.track = false;
	ctl.ops.length = 0;
	ctl.closes.clear();
	ctl.watchIno = null;
	ctl.watchedCloses = 0;
});

describe("the session log's sync on the thread pool", () => {
	it("1. an append resolves only after its own sync settles, and the event loop runs meanwhile", async () => {
		const root = dir();
		const store = new SessionStore(root);
		ctl.manual = true;
		const s = state(store.append("a", "r", ev(0)));
		await until(() => ctl.pending.length === 1);
		let ticked = false;
		setImmediate(() => (ticked = true));
		await turn();
		await turn();
		expect(ticked).toBe(true);
		expect(s.done).toBe(false);
		settle();
		await until(() => s.done);
		expect(s.failed).toBeUndefined();
		ctl.manual = false;
		await store.closeAll();
	});

	it("2. one session: one sync at a time and in order; two sessions: their syncs are pending together", async () => {
		const root = dir();
		const store = new SessionStore(root);
		ctl.manual = true;
		const first = state(store.append("a", "r", ev(0)));
		const second = state(store.append("a", "r", ev(1)));
		await until(() => ctl.pending.length === 1);
		for (let i = 0; i < 20; i++) await turn();
		expect(ctl.pending.length).toBe(1); // the second write waits for the first one's sync
		expect(store.load("a")).toHaveLength(1);
		settle();
		await until(() => first.done && ctl.pending.length === 1);
		expect(second.done).toBe(false);
		settle();
		await until(() => second.done);
		expect(store.load("a").map((r) => r.event.seq)).toEqual([0, 1]);

		const x = state(store.append("b", "r", ev(0)));
		const y = state(store.append("c", "r", ev(0)));
		await until(() => ctl.pending.length === 2); // two files: both syncs in flight at once
		settle();
		settle();
		await until(() => x.done && y.done);
		ctl.manual = false;
		await store.closeAll();
	});

	it("3. a sync pending, then close(): the lock is held until the sync settles, and close() settles only after it", async () => {
		const root = dir();
		const store = new SessionStore(root);
		await store.append("a", "r", ev(0));
		ctl.manual = true;
		const appending = state(store.append("a", "r", ev(1)));
		await until(() => ctl.pending.length === 1);
		const closing = state(store.close("a"));
		for (let i = 0; i < 20; i++) await turn();
		expect(closing.done).toBe(false);
		expect(lockText(root, "a")).not.toBe(""); // still ours: never released while a sync is in flight
		const rival = new SessionStore(root);
		await expect(rival.append("a", "r", ev(2))).rejects.toThrow(/locked|writer/);
		settle();
		await until(() => closing.done);
		expect(appending.done && appending.failed === undefined).toBe(true);
		expect(closing.failed).toBeUndefined();
		expect(lockText(root, "a")).toBe("");
		ctl.manual = false;
		await rival.closeAll();
	});

	it("4. A's sync fails: the append queued behind it is refused, and no other store takes the lock meanwhile", async () => {
		const root = dir();
		const store = new SessionStore(root);
		ctl.manual = true;
		const a = state(store.append("a", "r", ev(0)));
		const behind = state(store.append("a", "r", ev(1)));
		await until(() => ctl.pending.length === 1);
		const rival = new SessionStore(root);
		await expect(rival.append("a", "r", ev(1))).rejects.toThrow(/locked|writer/);
		settle(Object.assign(new Error("EIO: injected"), { code: "EIO" }));
		await until(() => a.done && behind.done);
		expect(String(a.failed)).toMatch(/EIO/);
		expect(behind.failed).toBeDefined();
		expect(store.load("a").map((r) => r.event.seq)).toEqual([0]); // nothing written behind the failed sync
		ctl.manual = false;
		// the failure was already delivered to the append's caller before the close began: the close cleans up and does not report it twice
		await expect(store.close("a")).resolves.toBeUndefined();
		expect(lockText(root, "a")).toBe("");
		await rival.closeAll();
	});

	it("5. close() settles, then a fresh store takes the session at once and reads the whole durable prefix", async () => {
		const root = dir();
		const store = new SessionStore(root);
		for (let i = 0; i < 5; i++) await store.append("a", "r", ev(i));
		await store.close("a");
		const fresh = new SessionStore(root);
		await fresh.append("a", "r", ev(5));
		expect(fresh.load("a").map((r) => r.event.seq)).toEqual([0, 1, 2, 3, 4, 5]);
		await fresh.closeAll();
	});

	it("6. close() settles, then the files are removed: no fs operation touches them afterwards", async () => {
		const root = dir();
		const store = new SessionStore(root);
		ctl.manual = true;
		const appending = state(store.append("a", "r", ev(0)));
		await until(() => ctl.pending.length === 1);
		const closing = store.close("a");
		settle();
		await closing;
		expect(appending.done).toBe(true);
		ctl.manual = false;
		ctl.track = true;
		rmSync(join(root, "a.jsonl"), { force: true });
		rmSync(join(root, "a.lock"), { force: true });
		for (let i = 0; i < 50; i++) await turn();
		await new Promise((r) => setTimeout(r, 20));
		expect(ctl.ops).toEqual([]);
		expect(existsSync(join(root, "a.jsonl"))).toBe(false);
	});

	it("A. an append waiting for a foreign lock: close() settles only after it refused, and nothing it acquired survives", async () => {
		const root = dir();
		const holder = new SessionStore(root);
		await holder.append("a", "r", ev(0)); // a foreign writer holds the lock
		const store = new SessionStore(root);
		const order: string[] = [];
		const appending = store.append("a", "r", ev(1)).then(
			() => order.push("append resolved"),
			(e: Error) => order.push(`append refused: ${e.message}`),
		);
		const closing = store.close("a").then(() => order.push("close resolved"));
		await holder.closeAll(); // the foreign lock goes
		await Promise.all([appending, closing]);
		expect(order[0]).toMatch(/^append refused: .*closed/);
		expect(order[1]).toBe("close resolved");
		expect(lockText(root, "a")).toBe(""); // no handle of ours survives
		const fresh = new SessionStore(root);
		await fresh.append("a", "r", ev(1));
		await fresh.closeAll();
	});

	it("B. one session's sync fails during closeAll: every session is closed and unlocked, and closeAll rejects", async () => {
		const root = dir();
		const store = new SessionStore(root);
		for (const id of ["a", "b", "c"]) await store.append(id, "r", ev(0));
		ctl.manual = true;
		const appends = ["a", "b", "c"].map((id) => state(store.append(id, "r", ev(1))));
		await until(() => ctl.pending.length === 3);
		const all = state(store.closeAll());
		for (let i = 0; i < 20; i++) await turn();
		expect(all.done).toBe(false); // it waits for every pending sync
		const order = ctl.pending.map((p) => p.fd);
		const fdOfA = order[0]!;
		for (const p of [...ctl.pending]) settle(p.fd === fdOfA ? Object.assign(new Error("EIO: injected"), { code: "EIO" }) : null);
		await until(() => all.done);
		expect(String(all.failed)).toMatch(/EIO/);
		expect(appends.filter((s) => s.failed !== undefined)).toHaveLength(1);
		ctl.manual = false;
		for (const id of ["a", "b", "c"]) expect(lockText(root, id)).toBe("");
		const fresh = new SessionStore(root);
		for (const id of ["a", "b", "c"]) await fresh.append(id, "r", ev(store.load(id).length));
		await fresh.closeAll();
	});

	it("C. a Work delete and closeAll racing on one session: one barrier, one fd close, one release", async () => {
		const root = dir();
		const store = new SessionStore(root);
		await store.append("a", "r", ev(0));
		ctl.manual = true;
		const appending = state(store.append("a", "r", ev(1)));
		await until(() => ctl.pending.length === 1);
		ctl.watchIno = statSync(join(root, "a.jsonl")).ino;
		ctl.watchedCloses = 0;
		const byDelete = store.close("a");
		expect(store.close("a")).toBe(byDelete); // the same barrier
		const byAll = store.closeAll();
		settle();
		await Promise.all([byDelete, byAll]);
		expect(appending.done).toBe(true);
		expect(ctl.watchedCloses).toBe(1); // the log's fd closed exactly once
		expect(lockText(root, "a")).toBe("");
		await expect(store.close("a")).resolves.toBeUndefined(); // idempotent afterwards
		expect(ctl.watchedCloses).toBe(1);
	});
});
