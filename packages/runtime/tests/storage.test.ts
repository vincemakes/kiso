/**
 * Area 1 — storage crash-safety and concurrency.
 *
 * The JSONL store must survive the real failure paths:
 * - a torn tail (crash mid-write) is repaired under lock BEFORE the next
 *   append — new JSON is never concatenated onto a fragment;
 * - mid-file corruption, valid-JSON-but-invalid-event lines, and seq
 *   discontinuities are LOUD errors, never silently-read prefixes;
 * - two writers (two processes, two stale handles) cannot both append;
 * - one AgentSession never runs two active runs;
 * - fds and the lock are released on close.
 */

import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { defineTool, EventLog, type Event } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

function tempStore(): { dir: string; store: SessionStore } {
	const dir = mkdtempSync(join(tmpdir(), "kiso-sto-"));
	return { dir, store: new SessionStore(dir) };
}

const ev = (seq: number, type = "stop" as const): Event => ({ seq, type, reason: "end_turn" });

describe("torn-tail repair", () => {
	it("a crash fragment is truncated before the next append — no JSON gets glued to it", async () => {
		const { dir, store } = tempStore();
		await store.append("s", "r1", ev(0));
		await store.append("s", "r1", ev(1));
		// Crash mid-write: a partial line, no trailing newline. The first
		// store "process" is gone — close releases its lock and fd.
		appendFileSync(join(dir, "s.jsonl"), '{"runId":"r1","event":');
		store.close("s");
		// A NEW store (new process) appends next.
		const store2 = new SessionStore(dir);
		await store2.append("s", "r2", ev(2));
		const records = store2.load("s");
		expect(records.map((r) => r.event.seq)).toEqual([0, 1, 2]);
		expect(records.map((r) => r.event.type)).toEqual(["stop", "stop", "stop"]);
		// The fragment is gone: the last line is the fresh record, and the
		// partial JSON was truncated, not glued to.
		const raw = readFileSync(join(dir, "s.jsonl"), "utf8");
		const rawLines = raw.split("\n");
		expect(rawLines.at(-2)?.startsWith('{"runId":"r2"')).toBe(true);
		expect(raw).not.toContain('"runId":"r1","event":');
	});

	it("an empty file appends cleanly", async () => {
		const { store } = tempStore();
		await store.append("s", "r1", ev(0));
		expect(store.load("s")).toHaveLength(1);
	});

	it("an in-process append failure cannot poison the next append (repair runs before EVERY append)", async () => {
		const { dir, store } = tempStore();
		await store.append("s", "r1", ev(0));
		// Simulate a partial write in THIS process (ENOSPC/EIO): a fragment
		// lands while the fd stays cached.
		appendFileSync(join(dir, "s.jsonl"), '{"runId":"r1","event":');
		await store.append("s", "r1", ev(1)); // cached fd — must repair first
		const records = store.load("s");
		expect(records.map((r) => r.event.seq)).toEqual([0, 1]);
	});
});

describe("corruption is loud, never silently read as a prefix", () => {
	it("mid-file garbage throws — at append time, before any further write", async () => {
		const { dir, store } = tempStore();
		await store.append("s", "r1", ev(0));
		appendFileSync(join(dir, "s.jsonl"), "THIS IS NOT JSON\n");
		// The CAS reads the file's real last committed seq — the garbage
		// line is detected here, so no new JSON is ever glued after it.
		await expect(store.append("s", "r1", ev(1))).rejects.toThrow(/corrupt|not JSON|record/i);
		expect(() => store.load("s")).toThrow();
	});

	it("valid JSON that is not a store record throws", async () => {
		const { dir, store } = tempStore();
		await store.append("s", "r1", ev(0));
		appendFileSync(join(dir, "s.jsonl"), '{"foo": 1}\n');
		await expect(store.append("s", "r1", ev(1))).rejects.toThrow(/corrupt|not JSON|record/i);
		expect(() => store.load("s")).toThrow();
	});

	it("a valid record whose event is not a kiso event throws", async () => {
		const { dir, store } = tempStore();
		await store.append("s", "r1", ev(0));
		appendFileSync(join(dir, "s.jsonl"), '{"runId":"r1","ts":1,"event":{"seq":1,"type":"nonsense"}}\n');
		expect(() => store.load("s")).toThrow();
	});

	it("seq discontinuity throws (missing or duplicated sequence numbers)", async () => {
		const { dir, store } = tempStore();
		await store.append("s", "r1", ev(0));
		appendFileSync(join(dir, "s.jsonl"), `${JSON.stringify({ runId: "r1", ts: 1, event: ev(2) })}\n`);
		expect(() => store.load("s")).toThrow(/seq/);

		const dir2 = mkdtempSync(join(tmpdir(), "kiso-sto-"));
		const store2 = new SessionStore(dir2);
		await store2.append("s", "r1", ev(0));
		appendFileSync(join(dir2, "s.jsonl"), `${JSON.stringify({ runId: "r1", ts: 1, event: ev(1) })}\n`);
		appendFileSync(join(dir2, "s.jsonl"), `${JSON.stringify({ runId: "r1", ts: 1, event: ev(1) })}\n`);
		expect(() => store2.load("s")).toThrow(/seq/);
	});
});

describe("cross-process single-writer", () => {
	it("a second writer cannot append while the first holds the lock", async () => {
		const { dir, store } = tempStore();
		await store.append("s", "r1", ev(0));
		const other = new SessionStore(dir);
		await expect(other.append("s", "r2", ev(1))).rejects.toThrow(/locked|writer/);
		// The first writer still owns the session.
		await store.append("s", "r1", ev(1));
		expect(store.load("s")).toHaveLength(2);
	});

	it("a stale lock (dead pid) is taken over", async () => {
		const { dir } = tempStore();
		writeFileSync(join(dir, "s.lock"), "99999999"); // a pid that is not alive
		const store = new SessionStore(dir);
		await store.append("s", "r1", ev(0));
		expect(store.load("s")).toHaveLength(1);
	});

	it("close releases the lock and the fd; appends after close are refused", async () => {
		const { dir, store } = tempStore();
		await store.append("s", "r1", ev(0));
		store.close("s");
		const other = new SessionStore(dir);
		await other.append("s", "r2", ev(1)); // lock released → other writer may proceed
		expect(other.load("s")).toHaveLength(2);
		await expect(store.append("s", "r3", ev(2))).rejects.toThrow(/closed/);
	});
});

describe("EventLog restore validation", () => {
	it("strictly validates seq === 0..N — array length never masks gaps or duplicates", async () => {
		expect(() => new EventLog([ev(0), ev(2)])).toThrow(/seq/);
		expect(() => new EventLog([ev(0), ev(1), ev(1)])).toThrow(/seq/);
		expect(() => new EventLog([ev(5)])).toThrow(/seq/);
		expect(new EventLog([ev(0), ev(1)])).toBeDefined();
	});
});

describe("one session, one active run", () => {
	it("a second run cannot start while the first is being consumed", async () => {
		const { store } = tempStore();
		const agent = createAgent({
			model: "faux",
			store,
			tools: [defineTool({ name: "x", description: "x", parameters: { type: "object" }, execute: async () => ({ content: "ok", isError: false }) })],
			adapter: createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]),
		});
		const session = await agent.session({ id: "s" });
		const first = session.run("one");
		const second = session.run("two");
		// Consuming the first marks it active; the second must refuse.
		let refused = false;
		for await (const _ev of first) {
			if (!refused) {
				// next() once: a rejected first next() already marks the
				// generator consumed, so it may only be probed a single time.
				await expect(second[Symbol.asyncIterator]().next()).rejects.toThrow(/active run|open run/);
				refused = true;
			}
			// drain to completion — a fresh run needs the first TERMINATED
			// (the persistence layer refuses new runs while one stays open).
		}
		// After the first completes, a fresh run is fine.
		for await (const _ev of session.run("three")) {
			// drain
		}
		expect(store.load("s").length).toBeGreaterThan(0);
	});
});

/**
 * REL-0152-D6 — the title has to say which conversation this is.
 *
 * `listSessions` took `records[0]` — the FIRST event — so a session is
 * named by whatever the user said first. Three of the owner's five
 * sessions opened with "hello", and the picker showed three identical
 * rows distinguished only by a timestamp they had to decode.
 *
 * RD1B-F9 made ids unique. Unique is not meaningful: the id can be
 * perfectly distinct and still tell a human nothing. The cheapest fix
 * that needs no model call is to name the session after the first turn
 * that carries a REQUEST, skipping an opening greeting.
 */
describe("REL-0152-D6 — the session title names the conversation", () => {
	it("skips an opening greeting and titles by the first real request", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-d6-"));
		const store = new SessionStore(dir);
		await store.append("s1", "r1", { seq: 0, type: "user_input", content: "hello" });
		await store.append("s1", "r1", { seq: 1, type: "user_input", content: "refactor the compositor's erase ranges" });
		const meta = store.list().find((m) => m.id === "s1");
		expect(meta?.title).toBe("refactor the compositor's erase ranges");
	});

	it("falls back to the greeting when that is all there is", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-d6b-"));
		const store = new SessionStore(dir);
		await store.append("s2", "r1", { seq: 0, type: "user_input", content: "hello" });
		expect(store.list().find((m) => m.id === "s2")?.title).toBe("hello");
	});
});
