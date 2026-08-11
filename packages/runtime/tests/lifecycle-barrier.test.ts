/**
 * round 5(P1) — the store's write lifecycle has no holes:
 *
 * P1-1: the WHOLE append critical section is serialized per session; a
 *       concurrent append can never land after a rejected (stale) write.
 * P1-2: a displaced/dead lock is detected — the store never writes locklessly.
 * P1-3: close() is a lifecycle barrier — an in-flight append fails and no
 *       lock handle outlives the instance.
 *
 * R-G 0.1.47 (ADR-0050) re-baselines: the round-5 tests killed the python3
 * helper process; the native link lock has no helper, so a dead/displaced
 * lock is simulated at the FILE (the holder's identity replaced or removed
 * from the lock path). The invariants are unchanged: a store whose lock is
 * gone refuses every write honestly — never a lockless write.
 */

import { chmodSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LockUnavailableError, SessionStore, type LockAdapter } from "../src/index.js";

const ev = (seq: number): Parameters<SessionStore["append"]>[2] => ({
	seq,
	type: "stop",
	reason: "end_turn",
});

function dir(): string {
	return mkdtempSync(join(tmpdir(), "kiso-life-"));
}

/** Unique-per-test session name (kept from round 5 — the suites share tmpdirs). */
let uid = 0;
function sess(): string {
	uid += 1;
	return `s-${process.pid}-${uid}`;
}

describe("store write lifecycle (round 5 P1)", () => {
	it("P1-1: a concurrent append can never land after a stale failure — the second write is rejected", async () => {
		const root = dir();
		// An external writer advanced the disk to seq 0.
		const id = sess();
		const external = new SessionStore(root);
		await external.append(id, "r1", ev(0));
		external.closeAll();

		// Two concurrent appends on ONE instance, both against the moved
		// disk: the first fails stale; the second must NOT land either.
		const store = new SessionStore(root);
		await expect(
			Promise.all([
				store.append(id, "r2", ev(0)),
				store.append(id, "r2", ev(1)),
			]),
		).rejects.toThrow(/stale|seq|poisoned/i);
		// The disk carries ONLY the external writer's record — nothing of
		// ours, not even the second write that was in flight.
		const records = new SessionStore(root).load(id);
		expect(records).toHaveLength(1);
		expect(records[0]!.runId).toBe("r1");
		store.closeAll(); // never leave our lock behind for later tests
	});

	it("P1-2: a displaced lock makes further appends fail — never a lockless write", async () => {
		const root = dir();
		const id = sess();
		const store = new SessionStore(root);
		await store.append(id, "r1", ev(0)); // holds the lock (its identity in the file)

		// ADR-0050 re-baseline: the round-5 simulation killed the helper
		// process; the file-level analog of "the holder's lock is dead" is
		// the lock path naming a dead foreign writer. The store must NOT
		// write through it.
		writeFileSync(join(root, `${id}.lock`), JSON.stringify({ pid: 99999999, token: "intruder" }));

		// The next append refuses honestly (strict refusal — no retry, no
		// wait heuristic; ADR-0050) — the disk never sees a lockless write.
		await expect(store.append(id, "r1", ev(1))).rejects.toThrow(/locked|writer/);
		// The disk carries ONLY the store's own record — nothing was written
		// without possession of the lock.
		expect(new SessionStore(root).load(id)).toHaveLength(1);
		store.closeAll();

		// The lock is recoverable: a fresh store takes over the dead
		// identity and holds the REAL lock (a further contender refuses
		// while it lives — the session resumes from a fresh store, ADR-0050).
		const fresh = new SessionStore(root);
		await fresh.append(id, "r2", ev(1));
		const contender = new SessionStore(root);
		await expect(contender.append(id, "r3", ev(2))).rejects.toThrow(/locked|writer/);
		fresh.closeAll();
		await expect(contender.append(id, "r3", ev(2))).resolves.toBeUndefined();
		contender.closeAll();
	});

	it("P1-2b: the fast path never trusts a displaced lock — a rival holds the real lock, our write FAILS", async () => {
		const root = dir();
		const id = sess();
		const store = new SessionStore(root);
		await store.append(id, "r1", ev(0)); // holds the lock
		// ADR-0050 re-baseline: the round-5 simulation killed the helper and
		// a rival took the flock; here the lock is displaced at the FILE —
		// removed, then a rival takes the REAL lock.
		unlinkSync(join(root, `${id}.lock`));
		const rival = new SessionStore(root);
		await rival.append(id, "r2", ev(1)); // takes the real lock
		// Our next append must FAIL (the lock is taken) — never succeed
		// locklessly behind a displaced handle.
		await expect(store.append(id, "r1", ev(1))).rejects.toThrow(/locked|writer/);
		expect(new SessionStore(root).load(id)).toHaveLength(2); // rival's only
		store.closeAll();
		rival.closeAll();
	});

	it("P1-3: close() is a lifecycle barrier — an in-flight append fails and no lock handle outlives the instance", async () => {
		const root = dir();
		const id = sess();
		const holder = new SessionStore(root);
		await holder.append(id, "r1", ev(0)); // holds the lock

		const store = new SessionStore(root);
		const appending = store.append(id, "r2", ev(1)); // waits on the lock
		store.close(id); // returns immediately
		await expect(appending).rejects.toThrow(/closed/i);
		holder.closeAll();
		// The release left the EMPTY released marker (the path is never
		// deleted — ADR-0050) and no handle outlives the instance: a fresh
		// writer may proceed.
		expect(readFileSync(join(root, `${id}.lock`), "utf8")).toBe("");
		const other = new SessionStore(root);
		await other.append(id, "r2", ev(1));
		expect(other.load(id)).toHaveLength(2);
		other.closeAll();
	});
});

describe("locking-unavailable errors (round 5 P2, re-baselined — ADR-0050)", () => {
	it("P2-1: a locking-unavailable condition is an HONEST error, never a lock conflict (adapter contract)", async () => {
		// The round-5 test ran a child with an empty PATH so the python3
		// spawn failed; the native mechanism has no spawn, so the taxonomy
		// is pinned at the CONTRACT: an adapter that cannot operate must
		// reject with LockUnavailableError, and the store must report
		// "locking unavailable" — never "locked by another writer".
		const stub: LockAdapter = {
			name: "stub-unavailable",
			acquire: async () => {
				throw new LockUnavailableError("stub mechanism unavailable (errno EACCES)");
			},
		};
		const root = dir();
		const store = new SessionStore(root, { lockAdapter: stub });
		await expect(store.append("s", "r1", ev(0))).rejects.toThrow(/locking unavailable/);
		await expect(store.append("s", "r1", ev(0))).rejects.not.toThrow(/locked by another writer/);
		store.closeAll();
	});

	it("P2-1b: an unwritable lock dir is an HONEST locking-unavailable error (real fs, EACCES)", async () => {
		if (typeof process.getuid === "function" && process.getuid() === 0) return; // root bypasses permissions
		const root = dir();
		const store = new SessionStore(root);
		chmodSync(root, 0o000);
		try {
			await expect(store.append("s", "r1", ev(0))).rejects.toThrow(/locking unavailable/);
			await expect(store.append("s", "r1", ev(0))).rejects.not.toThrow(/locked by another writer/);
		} finally {
			chmodSync(root, 0o755);
		}
		store.closeAll();
	});
});
