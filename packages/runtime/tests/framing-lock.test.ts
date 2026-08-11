/**
 * round 2 — framing consistency and lock-race safety.
 *
 * 1. A complete-JSON line WITHOUT a trailing newline is NOT committed: load
 *    must not return it, and append must not truncate something load
 *    accepted — the two views agree.
 * 2. stale-lock takeover must never blindly delete the path: the deletion
 *    is atomic-confirmed by identity (rename-away → verify token →
 *    restore-or-keep). A live lock is never removed by a contender.
 * 3. Two REAL concurrent processes race a stale lock behind a barrier:
 *    exactly one writer wins, the loser errors, the live lock survives.
 *
 * R-G 0.1.47 (ADR-0050): the lock suite now runs on the native
 * identity-confirmed link lock; the assertions are the spec and are
 * unchanged. The round-4 "flock" prose is gone with the python3 helper —
 * the takeover family this file pins IS the native mechanism's core.
 */

import { appendFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/index.js";

function tempStore(): { dir: string; store: SessionStore } {
	const dir = mkdtempSync(join(tmpdir(), "kiso-fl-"));
	return { dir, store: new SessionStore(dir) };
}

const ev = (seq: number): Parameters<SessionStore["append"]>[2] => ({
	seq,
	type: "stop",
	reason: "end_turn",
});

describe("framing: complete JSON without a trailing newline is NOT committed", () => {
	it("load does not return it, and append never truncates an accepted record", async () => {
		const { dir, store } = tempStore();
		await store.append("s", "r1", ev(0));
		// A complete JSON line WITHOUT a trailing newline — torn write.
		appendFileSync(join(dir, "s.jsonl"), `${JSON.stringify({ runId: "r2", ts: 1, event: ev(1) })}`, "utf8");
		// load must NOT treat it as committed (it may be a torn write whose
		// newline never landed).
		expect(store.load("s").map((r) => r.event.seq)).toEqual([0]);
		// append must not truncate an accepted record — seq 0 survives.
		await store.append("s", "r3", ev(1));
		expect(store.load("s").map((r) => r.event.seq)).toEqual([0, 1]);
	});

	it("a NEWLINE-terminated complete line IS committed and never truncated", async () => {
		const { dir, store } = tempStore();
		await store.append("s", "r1", ev(0));
		appendFileSync(join(dir, "s.jsonl"), `${JSON.stringify({ runId: "r2", ts: 1, event: ev(1) })}\n`, "utf8");
		expect(store.load("s").map((r) => r.event.seq)).toEqual([0, 1]);
		await store.append("s", "r3", ev(2));
		expect(store.load("s").map((r) => r.event.seq)).toEqual([0, 1, 2]);
	});
});

describe("stale-lock takeover is identity-confirmed, never a blind delete", () => {
	it("a contender that read a stale lock cannot delete a lock a rival created in between", async () => {
		const { dir } = tempStore();
		const lockPath = join(dir, "s.lock");
		// A dead holder's lock.
		writeFileSync(lockPath, JSON.stringify({ pid: 99999999, token: "dead-owner" }));

		// Contender A reads the stale lock (its takeover decision is based on
		// THIS identity)…
		const read = JSON.parse(readFileSync(lockPath, "utf8"));
		expect(read.token).toBe("dead-owner");

		// …then a rival B creates a LIVE lock before A acts.
		const storeB = new SessionStore(dir);
		await storeB.append("s", "r1", ev(0));
		const live = JSON.parse(readFileSync(lockPath, "utf8"));
		expect(live.token).not.toBe("dead-owner");

		// A now attempts its takeover — it must NOT delete B's live lock.
		const storeA = new SessionStore(dir);
		await expect(storeA.append("s", "r2", ev(1))).rejects.toThrow(/locked|writer/);
		// B's lock survives and B remains the single writer.
		expect(readFileSync(lockPath, "utf8")).toContain("token");
		await storeB.append("s", "r1", ev(1));
		expect(storeB.load("s")).toHaveLength(2);
	});

	it("a genuinely stale lock is taken over and the winner writes", async () => {
		const { dir } = tempStore();
		writeFileSync(join(dir, "s.lock"), JSON.stringify({ pid: 99999999, token: "dead" }));
		const store = new SessionStore(dir);
		await store.append("s", "r1", ev(0));
		expect(store.load("s")).toHaveLength(1);
	});
});

describe("lock semantics — legacy interop and the single-writer race (ADR-0050)", () => {
	it("a legacy lock naming a LIVE pid refuses writes — the identity gate refuses before any takeover", async () => {
		const { dir } = tempStore();
		// A legacy-format writer (the round-2 O_EXCL pidfile scheme) is still
		// alive: it does not share the current mechanism, so only its
		// identity in the file stops us.
		writeFileSync(join(dir, "s.lock"), String(process.pid)); // legacy bare pid
		const store = new SessionStore(dir);
		await expect(store.append("s", "r1", ev(0))).rejects.toThrow(/locked by another writer \(pid/);
		// The modern JSON form is refused the same way — with a FOREIGN live
		// pid. (A modern lock naming OUR OWN process is a same-process
		// writer's residue: it is tolerated and retried, not refused.)
		const { spawn } = await import("node:child_process");
		// a LIVE unrelated process for the foreign-pid fixture (node — the
		// suite is python3-free after the ADR-0050 retirement)
		const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		writeFileSync(join(dir, "s.lock"), JSON.stringify({ pid: sleeper.pid, token: "foreign" }));
		await expect(store.append("s", "r1", ev(0))).rejects.toThrow(/locked by another writer \(pid/);
		sleeper.kill();
	});

	it("JSON.parse('123') is a bare legacy pid, never an object without a pid", async () => {
		const { dir } = tempStore();
		// "123" parses as the NUMBER 123 — it must be read as pid 123. That
		// pid is (almost certainly) not alive, so the lock is acquirable;
		// the important part is it was never treated as "no pid".
		writeFileSync(join(dir, "s.lock"), "123");
		const store = new SessionStore(dir);
		await store.append("s", "r1", ev(0));
		expect(store.load("s")).toHaveLength(1);
	});

	it("an EMPTY lock file is harmless — the released marker / legacy residue is taken over", async () => {
		const { dir } = tempStore();
		writeFileSync(join(dir, "s.lock"), "");
		// ADR-0050: under the link lock, empty is the released marker (or a
		// legacy-format crash residue) — quarantine-arbitrated, it is taken
		// over because the empty state cannot name a live holder. (Under
		// the round-4 flock the kernel arbitrated; assertions unchanged.)
		const store = new SessionStore(dir);
		await store.append("s", "r1", ev(0));
		expect(store.load("s")).toHaveLength(1);
	});

	it("a HALF-WRITTEN lock file is harmless — unreadable content is residue, no recursion, no wedge", async () => {
		const { dir } = tempStore();
		writeFileSync(join(dir, "s.lock"), '{"pid": 99'); // crashed mid-write
		const store = new SessionStore(dir);
		await store.append("s", "r1", ev(0));
		expect(store.load("s")).toHaveLength(1);
	});

	it("a dead legacy pid is taken over — the file is never deleted", async () => {
		const { dir } = tempStore();
		writeFileSync(join(dir, "s.lock"), JSON.stringify({ pid: 99999999, token: "dead" }));
		const store = new SessionStore(dir);
		await store.append("s", "r1", ev(0));
		// The stale file is replaced by identity confirmation (rename-away →
		// verify → link), never blindly deleted: no contender ever deletes a
		// lock path, and the path always carries a token afterwards.
		expect(readFileSync(join(dir, "s.lock"), "utf8")).toContain("token");
		expect(store.load("s")).toHaveLength(1);
	});

	it("THREE real processes race behind a barrier: exactly one writer, deterministically", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-race3-"));
		writeFileSync(join(dir, "s.lock"), JSON.stringify({ pid: 99999999, token: "dead" }));
		const barrier = join(dir, "barrier");

		const contender = `
import { SessionStore } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const dir = ${JSON.stringify(dir)};
const barrier = ${JSON.stringify(barrier)};
const store = new SessionStore(dir);
const ready = join(dir, "ready-" + process.pid);
writeFileSync(ready, "1");
while (!existsSync(barrier)) { await new Promise((r) => setTimeout(r, 2)); }
try {
  await store.append("s", "r-" + process.pid, { seq: 0, type: "stop", reason: "end_turn" });
  console.log("WINNER");
} catch (e) {
  console.log("LOSER");
} finally {
  store.closeAll();
}
`;
		const { spawn } = await import("node:child_process");
		const results: string[] = [];
		const run = (name: string) =>
			new Promise<void>((resolve) => {
				const child = spawn(process.execPath, ["--input-type=module", "-e", contender], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				let out = "";
				child.stdout.on("data", (d: Buffer) => (out += d.toString()));
				child.stderr.on("data", (d: Buffer) => (out += d.toString()));
				child.on("close", () => {
					results.push(`${name}: ${out.trim().split("\n").at(-1)}`);
					resolve();
				});
			});

		const p1 = run("A");
		const p2 = run("B");
		const p3 = run("C");
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const entries = readdirSync(dir);
			if (entries.filter((f) => f.startsWith("ready-")).length >= 3) break;
			await new Promise((r) => setTimeout(r, 10));
		}
		writeFileSync(barrier, "go");
		await Promise.all([p1, p2, p3]);

		expect(results.filter((r) => r.endsWith("WINNER"))).toHaveLength(1); // exactly one writer
		expect(results.filter((r) => r.endsWith("LOSER"))).toHaveLength(2);
		// The winner's write is the only record.
		const store = new SessionStore(dir);
		expect(store.load("s")).toHaveLength(1);
	});
});

describe("two REAL concurrent processes race a stale lock behind a barrier (round 2)", () => {
	it("exactly one writer wins, the loser errors, the live lock survives", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-race-"));
		writeFileSync(join(dir, "s.lock"), JSON.stringify({ pid: 99999999, token: "dead" }));
		const barrier = join(dir, "barrier");

		const contender = `
import { SessionStore } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const dir = ${JSON.stringify(dir)};
const barrier = ${JSON.stringify(barrier)};
const store = new SessionStore(dir);
// Signal readiness, then WAIT for the barrier so both contenders race the
// takeover at the same instant.
const ready = join(dir, "ready-" + process.pid);
writeFileSync(ready, "1");
while (!existsSync(barrier)) { await new Promise((r) => setTimeout(r, 2)); }
try {
  await store.append("s", "r-" + process.pid, { seq: 0, type: "stop", reason: "end_turn" });
  console.log("WINNER");
} catch (e) {
  console.log("LOSER:" + e.message);
}
`;
		const { spawn } = await import("node:child_process");
		const results: string[] = [];
		const run = (name: string) =>
			new Promise<void>((resolve) => {
				const child = spawn(process.execPath, ["--input-type=module", "-e", contender], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				let out = "";
				child.stdout.on("data", (d: Buffer) => (out += d.toString()));
				child.stderr.on("data", (d: Buffer) => (out += d.toString()));
				child.on("close", () => {
					results.push(`${name}: ${out.trim().split("\n").at(-1)}`);
					resolve();
				});
			});

		// Wait for both contenders to be READY (both read the stale lock or
		// race the takeover), then release the barrier together.
		const p1 = run("A");
		const p2 = run("B");
		// The contenders write ready-<pid>; poll for both before releasing.
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const entries = readdirSync(dir);
			if (entries.filter((f) => f.startsWith("ready-")).length >= 2) break;
			await new Promise((r) => setTimeout(r, 10));
		}
		writeFileSync(barrier, "go");
		await Promise.all([p1, p2]);

		const winners = results.filter((r) => r.endsWith("WINNER"));
		const losers = results.filter((r) => r.startsWith("A: LOSER") || r.startsWith("B: LOSER"));
		expect(winners).toHaveLength(1); // exactly one writer
		expect(losers).toHaveLength(1);
		// The live lock survives and holds the winner's token.
		const lock = JSON.parse(readFileSync(join(dir, "s.lock"), "utf8"));
		expect(typeof lock.token).toBe("string");
		// The winner's write is the only record.
		const store = new SessionStore(dir);
		expect(store.load("s")).toHaveLength(1);
	});
});
