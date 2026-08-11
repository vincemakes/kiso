/**
 * R-G 0.1.47 (ADR-0050) — the native identity-confirmed link lock, its race
 * family, red→green. This file is the mechanism's own gate:
 *
 * 1. kill-mid-acquire — the residue family: the final path exists only by
 *    linking a fully-fsynced identity file, so a kill can never leave an
 *    empty or half-written lock. Every constructed residue is acquirable,
 *    and a real SIGKILL mid-hold leaves a cleanly takeover-able dead lock.
 * 2. stale residue — a dead holder's file is taken over by identity
 *    confirmation (rename-away → verify → link), never a blind delete; the
 *    path always carries a token.
 * 3. PID reuse — a stale file naming a LIVE (recycled) pid is refused,
 *    never taken over: the session stays locked until that pid dies
 *    (refuse-happy, never two writers — ADR-0050), then the same store
 *    acquires and the session continues.
 * 4. the displacement cascade (adjudicated 2026-08-11) — a false-dead
 *    reader's stale read, a live holder, and a third contender racing the
 *    restore: exactly one writer at every instant, the displaced holder's
 *    next append self-refuses honestly, and a fresh store re-acquires so
 *    the session continues. The residual is pinned by this gate, not by
 *    argument (ADR-0050 §residual).
 *
 * The cascade choreography uses the adapter's TEST-ONLY affordances
 * (KISO_LOCK_TEST_* env, default off — ADR-0050): the false-dead reader
 * freezes between read and rename-away, and between rename-away and verify,
 * via fixed pauses plus SIGSTOP/SIGCONT; the freeze points are located via
 * ready-marker files.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LockedError, SessionStore, nativeLockAdapter } from "../src/index.js";

function tempStore(): { dir: string; store: SessionStore } {
	const dir = mkdtempSync(join(tmpdir(), "kiso-nlr-"));
	return { dir, store: new SessionStore(dir) };
}

const ev = (seq: number): Parameters<SessionStore["append"]>[2] => ({
	seq,
	type: "stop",
	reason: "end_turn",
});

async function waitFor(path: string, timeoutMs = 3000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		try {
			readFileSync(path);
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 5));
		}
	}
	throw new Error(`timed out waiting for ${path}`);
}

describe("kill-mid-acquire: no empty final path is producible (ADR-0050)", () => {
	it("a stray tmp (killed between write and link) is inert — the next acquirer proceeds", async () => {
		const { dir, store } = tempStore();
		writeFileSync(join(dir, "s.lock.tmp-999-deadbeef"), JSON.stringify({ pid: 99999999, token: "halfway" }));
		await store.append("s", "r1", ev(0));
		expect(store.load("s")).toHaveLength(1);
		store.closeAll();
	});

	it("a stray tmp + a full dead lock (killed after the link) — clean takeover", async () => {
		const { dir, store } = tempStore();
		writeFileSync(join(dir, "s.lock"), JSON.stringify({ pid: 99999999, token: "dead" }));
		writeFileSync(join(dir, "s.lock.tmp-999-deadbeef"), JSON.stringify({ pid: 99999999, token: "halfway" }));
		await store.append("s", "r1", ev(0));
		expect(store.load("s")).toHaveLength(1);
		// The final path always carries a token — never empty or half-written.
		expect(readFileSync(join(dir, "s.lock"), "utf8")).toContain("token");
		store.closeAll();
	});

	it("a REAL SIGKILL mid-hold: the dead holder's lock is taken over by a fresh store", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-nlr-kill-"));
		const held = join(dir, "held");
		const holderScript = `
import { SessionStore } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
import { writeFileSync } from "node:fs";
const store = new SessionStore(${JSON.stringify(dir)});
await store.append("s", "rH", { seq: 0, type: "stop", reason: "end_turn" });
writeFileSync(${JSON.stringify(held)}, "1");
// A REAL live handle: with stdio "ignore" the loop would otherwise drain
// and node self-exits with code 13 (unsettled top-level await) — the test
// must kill mid-hold, so only SIGKILL may end the holder.
setInterval(() => {}, 1000);
`;
		const { spawn } = await import("node:child_process");
		const h = spawn(process.execPath, ["--input-type=module", "-e", holderScript], { stdio: "ignore" });
		await waitFor(held);
		// kill -9 while the holder holds the lock — the residue is a full
		// dead identity at the final path (the kernel-arbitrated flock-era
		// auto-release has no analog here; the file IS the lock, ADR-0050).
		h.kill("SIGKILL");
		// "exit" — the child dies by SIGKILL only (its loop is pinned); exit
		// is the event for "the process is dead".
		await once(h, "exit");
		const fresh = new SessionStore(dir);
		await fresh.append("s", "rN", { seq: 1, type: "stop", reason: "end_turn" });
		expect(fresh.load("s").map((r) => r.event.seq)).toEqual([0, 1]);
		fresh.closeAll();
	});
});

describe("stale residue — identity-confirmed takeover, never a blind delete (ADR-0050)", () => {
	it("a dead holder's file is taken over by rename-away → verify → link; the path always carries a token", async () => {
		const { dir } = tempStore();
		const lockPath = join(dir, "s.lock");
		writeFileSync(lockPath, JSON.stringify({ pid: 99999999, token: "dead" }));
		const h1 = await nativeLockAdapter.acquire(lockPath, "s", () => {});
		const identity = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; token: string };
		expect(identity.pid).toBe(process.pid);
		expect(typeof identity.token).toBe("string");
		expect(h1.verify()).toBe(true);
		// A live holder refuses a takeover attempt.
		await expect(nativeLockAdapter.acquire(lockPath, "s", () => {})).rejects.toBeInstanceOf(LockedError);
		h1.release();
		// Release leaves the EMPTY released marker — the path is never deleted.
		expect(readFileSync(lockPath, "utf8")).toBe("");
		const h2 = await nativeLockAdapter.acquire(lockPath, "s", () => {});
		expect(h2.verify()).toBe(true);
		h2.release();
	});

	it("a HALF-WRITTEN dead file is taken over — unreadable content is residue", async () => {
		const { dir } = tempStore();
		const lockPath = join(dir, "s.lock");
		writeFileSync(lockPath, '{"pid": 99'); // crashed mid-write
		const h = await nativeLockAdapter.acquire(lockPath, "s", () => {});
		expect(h.verify()).toBe(true);
		h.release();
	});
});

describe("PID reuse — refuse-happy, never two writers (ADR-0050)", () => {
	it("a stale file naming a LIVE (recycled) pid is refused; the session recovers when the pid dies", async () => {
		const { dir, store } = tempStore();
		const lockPath = join(dir, "s.lock");
		const { spawn } = await import("node:child_process");
		const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		// Stale residue whose pid was recycled by a live unrelated process.
		writeFileSync(lockPath, JSON.stringify({ pid: sleeper.pid, token: "ancient" }));
		// The recycled pid looks alive — the takeover must NOT proceed (a
		// dead holder whose pid a stranger inherited must not hand the
		// session over; refuse-happy never splits a writer, ADR-0050).
		await expect(store.append("s", "r1", ev(0))).rejects.toThrow(/locked by another writer \(pid/);
		expect(new SessionStore(dir).load("s")).toHaveLength(0); // nothing written
		// The operator relief (ADR-0050): the session stays locked until
		// the recycled pid dies — then the same store acquires.
		sleeper.kill();
		await once(sleeper, "close");
		await store.append("s", "r1", ev(0));
		expect(store.load("s")).toHaveLength(1);
		store.closeAll();
	});
});

describe("the displacement cascade — gated, not argued (adjudicated 2026-08-11, ADR-0050 §residual)", () => {
	it("a false-dead reader + a live holder + a third contender: exactly one writer, the holder self-refuses, a fresh store resumes the session", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-nlr-casc-"));
		const id = "s";
		const lockPath = join(dir, `${id}.lock`);
		const readyDir = join(dir, "ready");
		mkdirSync(readyDir);

		// 1. The false-dead reader's stale view: a dead identity.
		writeFileSync(lockPath, JSON.stringify({ pid: 99999999, token: "dead" }));

		// 2. The false-dead reader C: reads the stale identity, freezes in
		//    the READ pause (test-only hook) — the test stops it there.
		const contender = `
import { SessionStore } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
const store = new SessionStore(${JSON.stringify(dir)});
try {
  await store.append("s", "rC", { seq: 0, type: "stop", reason: "end_turn" });
  console.log("C-APPENDED");
} catch (e) {
  console.log("C-REJECTED:" + e.message);
} finally {
  store.closeAll();
}
`;
		const { spawn } = await import("node:child_process");
		const c = spawn(process.execPath, ["--input-type=module", "-e", contender], {
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				KISO_LOCK_TEST_READY_DIR: readyDir,
				KISO_LOCK_TEST_PAUSE_READ_MS: "1000",
				KISO_LOCK_TEST_PAUSE_TAKEOVER_MS: "1000",
			},
		});
		c.stdout.on("data", () => {});
		c.stderr.on("data", () => {});
		await waitFor(join(readyDir, `read-${c.pid}`));
		process.kill(c.pid!, "SIGSTOP");

		// 3. The live holder takes over the stale file and writes.
		const holder = new SessionStore(dir);
		await holder.append(id, "rH", { seq: 0, type: "stop", reason: "end_turn" });

		// 4. C wakes, moves the HOLDER'S LIVE file away, and freezes in the
		//    TAKEOVER pause holding it — stop C there.
		process.kill(c.pid!, "SIGCONT");
		await waitFor(join(readyDir, `takeover-${c.pid}`));
		process.kill(c.pid!, "SIGSTOP");

		// 5. The third contender K links into the now-absent path and dies.
		const third = `
import { SessionStore } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
const store = new SessionStore(${JSON.stringify(dir)});
await store.append("s", "rK", { seq: 1, type: "stop", reason: "end_turn" });
store.closeAll();
process.exit(0);
`;
		const k = spawn(process.execPath, ["--input-type=module", "-e", third], { stdio: "ignore" });
		await once(k, "close");

		// 6. C wakes: its verify fails (the moved file is the HOLDER's, not
		//    the stale identity it read) — the restore hits K's file
		//    (EEXIST) and the moved file is abandoned as inert residue.
		//    C then re-reads, takes over K's DEAD file, and its own append
		//    dies on the stale seq — C exits.
		process.kill(c.pid!, "SIGCONT");
		await once(c, "close");

		// 7. The displaced holder's next append SELF-REFUSES honestly — the
		//    possession check (strict refusal, no retry) — never a second
		//    writer.
		await expect(holder.append(id, "rH", { seq: 1, type: "stop", reason: "end_turn" })).rejects.toThrow(/locked|writer/);
		// The disk holds exactly the holder's pre-displacement record and
		// the third contender's — nothing from the displaced attempt.
		expect(new SessionStore(dir).load(id).map((r) => r.event.seq)).toEqual([0, 1]);
		// The displacement's fingerprint: the moved live file lingers at an
		// inert staging name — never at the lock path.
		const orphans = readdirSync(dir).filter((n) => n.startsWith(`${id}.lock.staging-`));
		expect(orphans).toHaveLength(1);
		holder.closeAll();

		// 8. The session continues: a fresh store takes over the dead
		//    holder's lock and writes (the resume path, ADR-0050).
		const fresh = new SessionStore(dir);
		await fresh.append(id, "rN", { seq: 2, type: "stop", reason: "end_turn" });
		expect(fresh.load(id).map((r) => r.event.seq)).toEqual([0, 1, 2]);
		fresh.closeAll();
	});
});
