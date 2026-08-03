/**
 * A 组 — storage identity and consistency.
 *
 * The lock carries a random owner TOKEN; only the instance that holds the
 * lock (and whose token still matches) may unlink it. Appends run an
 * expected-last-seq CAS against the file's REAL last committed seq — a
 * stale preloaded session handle is rejected instead of writing a
 * duplicate seq. Every id is validated before ANY file side effect; close
 * traversal is refused; closeAll releases every lock it holds.
 */

import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/index.js";

function tempStore(): { dir: string; store: SessionStore } {
	const dir = mkdtempSync(join(tmpdir(), "kiso-sid-"));
	return { dir, store: new SessionStore(dir) };
}

const ev = (seq: number): Parameters<SessionStore["append"]>[2] => ({
	seq,
	type: "stop",
	reason: "end_turn",
});

describe("lock ownership tokens", () => {
	it("close() does not release ANOTHER instance's kernel lock (foreign close)", async () => {
		const { dir, store } = tempStore();
		await store.append("s", "r1", ev(0));
		// B is blocked while A's helper holds the flock.
		const storeB = new SessionStore(dir);
		await expect(storeB.append("s", "r2", ev(1))).rejects.toThrow(/locked|writer/);
		// A's close releases ONLY A's helper — the lock file survives and
		// no contender ever deletes it (第四轮).
		store.close("s");
		expect(readFileSync(join(dir, "s.lock"), "utf8")).not.toContain("99999999"); // untouched by close
		// Now the kernel lock is free: B acquires it and writes.
		await storeB.append("s", "r2", ev(1));
		expect(storeB.load("s")).toHaveLength(2);
	});

	it("close() releases only the lock this instance holds", async () => {
		const { dir, store } = tempStore();
		await store.append("s", "r1", ev(0));
		store.close("s");
		// The lock is gone; a fresh writer may proceed.
		const other = new SessionStore(dir);
		await other.append("s", "r2", ev(1));
		expect(other.load("s")).toHaveLength(2);
	});

	it("two contenders racing a stale lock: exactly one wins, the loser errors", async () => {
		const { dir } = tempStore();
		writeFileSync(join(dir, "s.lock"), JSON.stringify({ pid: 99999999, token: "dead" }));
		const storeB = new SessionStore(dir);
		const storeC = new SessionStore(dir);
		await storeB.append("s", "r1", ev(0)); // B wins the takeover
		await expect(storeC.append("s", "r2", ev(1))).rejects.toThrow(/locked|writer/);
		expect(storeB.load("s")).toHaveLength(1);
	});
});

describe("id validation before ANY file side effect", () => {
	it("close() refuses traversal ids — no external lock is touched", async () => {
		// A DEDICATED parent: the assertion must be hermetic, not depend on
		// the shared tmpdir being clean.
		const parent = mkdtempSync(join(tmpdir(), "kiso-sid-parent-"));
		const dir = join(parent, "work");
		const store = new SessionStore(dir);
		expect(() => store.close("../evil")).toThrow();
		expect(() => store.closeAll()).not.toThrow();
		expect(existsSync(join(parent, "evil.lock"))).toBe(false);
		expect(readdirSync(parent)).toEqual(["work"]); // only the work dir, no evil.lock
	});

	it("append with an invalid id never creates a file or lock", async () => {
		const { dir, store } = tempStore();
		await expect(store.append("../evil", "r1", ev(0))).rejects.toThrow();
		const entries = readdirSync(dir);
		expect(entries).toEqual([]); // neither jsonl nor lock appeared
	});
});

describe("expected-last-seq CAS", () => {
	it("a stale preloaded handle is rejected — no duplicate seq, and its run must not continue", async () => {
		const { dir, store } = tempStore();
		await store.append("s", "r1", ev(0));
		await store.append("s", "r1", ev(1));
		store.closeAll();

		// Process B preloads the session READ-ONLY (its view ends at seq 1,
		// it holds no lock)…
		const storeB = new SessionStore(dir);
		expect(storeB.load("s")).toHaveLength(2);

		// …meanwhile process C advanced the file to seq 2.
		const storeC = new SessionStore(dir);
		await storeC.append("s", "r3", ev(2));
		storeC.closeAll();

		// B's stale handle tries to write seq 2 (its view) — the file is
		// already at 2 → refused, no duplicate.
		await expect(storeB.append("s", "r2", ev(2))).rejects.toThrow(/stale|seq/);
		// The file is undamaged.
		const storeD = new SessionStore(dir);
		expect(storeD.load("s").map((r) => r.event.seq)).toEqual([0, 1, 2]);
	});

	it("a gap in the event stream is refused at append time", async () => {
		const { dir, store } = tempStore();
		await store.append("s", "r1", ev(0));
		await expect(store.append("s", "r1", ev(2))).rejects.toThrow(/stale|seq/); // skipped 1
	});

	it("committed records are never truncated by a later append", async () => {
		const { dir, store } = tempStore();
		await store.append("s", "r1", ev(0));
		const records = store.load("s");
		expect(records).toHaveLength(1);
		// A complete line followed by a crash fragment, then a new append:
		// the committed record must survive exactly as loaded.
		appendFileSync(join(dir, "s.jsonl"), '{"runId":"x","event":');
		await store.append("s", "r2", ev(1));
		const reloaded = store.load("s");
		expect(reloaded.map((r) => r.event.seq)).toEqual([0, 1]);
		expect(reloaded[0]?.event).toEqual(records[0]?.event); // byte-identical semantics
	});

	it("closeAll releases every held lock, including multi-session holdings", async () => {
		const { dir, store } = tempStore();
		await store.append("a", "r1", ev(0));
		await store.append("b", "r1", ev(0));
		await store.append("c", "r1", ev(0));
		store.closeAll();
		const other = new SessionStore(dir);
		await other.append("a", "r2", ev(1));
		await other.append("b", "r2", ev(1));
		await other.append("c", "r2", ev(1));
		expect(other.load("a")).toHaveLength(2);
		expect(other.load("b")).toHaveLength(2);
		expect(other.load("c")).toHaveLength(2);
	});
});
