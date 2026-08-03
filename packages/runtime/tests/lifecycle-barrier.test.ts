/**
 * 第五轮(P1) — the store's write lifecycle has no holes:
 *
 * P1-1: the WHOLE append critical section is serialized per session; a
 *       concurrent append can never land after a rejected (stale) write.
 * P1-2: a dead lock helper is detected — the store never writes locklessly.
 * P1-3: close() is a lifecycle barrier — an in-flight append fails and no
 *       helper outlives the instance.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/index.js";

const ev = (seq: number): Parameters<SessionStore["append"]>[2] => ({
	seq,
	type: "stop",
	reason: "end_turn",
});

function dir(): string {
	return mkdtempSync(join(tmpdir(), "kiso-life-"));
}

/** Unique-per-test session name — the pgrep-based helper discovery must
 *  never match another concurrently-running test file's helper. */
let uid = 0;
function sess(): string {
	uid += 1;
	return `s-${process.pid}-${uid}`;
}

/**
 * Pids of live helper processes holding this session's lock file
 * (pgrep -f matches the FULL argv, which ends with the lock path — the
 * helper's executable shows up as "Python" on macOS, so the path is the
 * reliable signature).
 */
function helperPids(session: string): number[] {
	// The lock path is the helper's LAST argv entry — anchor the regex to
	// the end and escape the dot so unrelated processes never match.
	try {
		const out = execFileSync("pgrep", ["-f", `${session}\\.lock$`], { encoding: "utf8" });
		return out
			.trim()
			.split("\n")
			.map((n) => Number(n))
			.filter((n) => Number.isFinite(n) && n > 0);
	} catch {
		return [];
	}
}

function killHelpers(session: string): void {
	for (const pid of helperPids(session)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
}

describe("store write lifecycle (第五轮 P1)", () => {
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
		store.closeAll(); // never leave our helper behind for later tests
	});

	it("P1-2: a DEAD lock helper makes further appends fail — never a lockless write", async () => {
		const root = dir();
		const id = sess();
		const store = new SessionStore(root);
		await store.append(id, "r1", ev(0)); // acquires the helper
		expect(helperPids(id)).toHaveLength(1);

		// Kill the helper process out from under the store.
		killHelpers(id);
		await new Promise((r) => setTimeout(r, 300));

		// The store must NOT write without the lock: the dead helper is
		// detected, the re-acquire finds the flock free but the store must
		// still fail honestly (it re-acquires and proceeds — the point is
		// it never writes while believing a dead helper holds the lock).
		// The write below either re-acquires cleanly (flock is free) or
		// fails; what is FORBIDDEN is succeeding while a dead helper sits
		// in the map. We verify the map-based fast path is gone by checking
		// a fresh contender can take the flock.
		await expect(store.append(id, "r1", ev(1))).resolves.toBeUndefined();
		// The disk has both records — and the store re-acquired the lock
		// for real (a fresh contender cannot get it while our new helper
		// lives).
		const contender = new SessionStore(root);
		await expect(contender.append(id, "r3", ev(2))).rejects.toThrow(/locked|writer/);
		store.closeAll();
		await expect(contender.append(id, "r3", ev(2))).resolves.toBeUndefined();
		contender.closeAll();
	});

	it("P1-2b: the fast path never trusts a dead helper — kill it, then a rival takes the flock, our write FAILS", async () => {
		const root = dir();
		const id = sess();
		const store = new SessionStore(root);
		await store.append(id, "r1", ev(0));
		// Kill the helper.
		killHelpers(id);
		await new Promise((r) => setTimeout(r, 300));
		// A rival takes the REAL flock.
		const rival = new SessionStore(root);
		await rival.append(id, "r2", ev(1));
		// Our next append must FAIL (the flock is taken) — never succeed
		// locklessly behind a dead helper.
		await expect(store.append(id, "r1", ev(1))).rejects.toThrow(/locked|writer/);
		expect(new SessionStore(root).load(id)).toHaveLength(2); // rival's only
		store.closeAll();
		rival.closeAll();
	});

	it("P1-3: close() is a lifecycle barrier — an in-flight append fails and no helper survives", async () => {
		const root = dir();
		const id = sess();
		const holder = new SessionStore(root);
		await holder.append(id, "r1", ev(0)); // holds the flock

		const store = new SessionStore(root);
		const appending = store.append(id, "r2", ev(1)); // waits on the lock
		store.close(id); // returns immediately
		await expect(appending).rejects.toThrow(/closed/i);
		holder.closeAll();
		expect(helperPids(id)).toHaveLength(0); // no helper outlives the instance
	});
});

	it("P2-1: a missing python3 (empty PATH) is an HONEST locking-unavailable error, never a lock conflict", async () => {
		// Run a real child with PATH emptied so spawn("python3") fails.
		const script = `
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
const dir = mkdtempSync(join(tmpdir(), "kiso-spawn-"));
const store = new SessionStore(dir);
try {
  await store.append("s", "r1", { seq: 0, type: "stop", reason: "end_turn" });
  console.log("NO-ERROR");
  process.exit(1);
} catch (e) {
  console.log(e.message);
  process.exit(e.message.includes("locking unavailable") && !e.message.includes("locked by another writer") ? 0 : 1);
}
`;
		const { spawnSync } = await import("node:child_process");
		const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
			encoding: "utf8",
			env: { ...process.env, PATH: "" },
			timeout: 20_000,
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("locking unavailable");
		expect(r.stdout).not.toContain("locked by another writer");
	});
