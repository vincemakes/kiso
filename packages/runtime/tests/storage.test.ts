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
import { createFauxProvider } from "@kiso/evals";
import { defineTool, EventLog, type Event } from "@kiso/core";
import { createAgent, SessionStore } from "../src/index.js";

function tempStore(): { dir: string; store: SessionStore } {
	const dir = mkdtempSync(join(tmpdir(), "kiso-sto-"));
	return { dir, store: new SessionStore(dir) };
}

const ev = (seq: number, type = "stop" as const): Event => ({ seq, type, reason: "end_turn" });

describe("torn-tail repair", () => {
	it("a crash fragment is truncated before the next append — no JSON gets glued to it", () => {
		const { dir, store } = tempStore();
		store.append("s", "r1", ev(0));
		store.append("s", "r1", ev(1));
		// Crash mid-write: a partial line, no trailing newline. The first
		// store "process" is gone — close releases its lock and fd.
		appendFileSync(join(dir, "s.jsonl"), '{"runId":"r1","event":');
		store.close("s");
		// A NEW store (new process) appends next.
		const store2 = new SessionStore(dir);
		store2.append("s", "r2", ev(2));
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

	it("an empty file appends cleanly", () => {
		const { store } = tempStore();
		store.append("s", "r1", ev(0));
		expect(store.load("s")).toHaveLength(1);
	});
});

describe("corruption is loud, never silently read as a prefix", () => {
	it("mid-file garbage throws", () => {
		const { dir, store } = tempStore();
		store.append("s", "r1", ev(0));
		appendFileSync(join(dir, "s.jsonl"), "THIS IS NOT JSON\n");
		store.append("s", "r1", ev(1)); // a complete line AFTER the garbage
		expect(() => store.load("s")).toThrow();
	});

	it("valid JSON that is not a store record throws", () => {
		const { dir, store } = tempStore();
		store.append("s", "r1", ev(0));
		appendFileSync(join(dir, "s.jsonl"), '{"foo": 1}\n');
		store.append("s", "r1", ev(1));
		expect(() => store.load("s")).toThrow();
	});

	it("a valid record whose event is not a kiso event throws", () => {
		const { dir, store } = tempStore();
		store.append("s", "r1", ev(0));
		appendFileSync(join(dir, "s.jsonl"), '{"runId":"r1","ts":1,"event":{"seq":1,"type":"nonsense"}}\n');
		expect(() => store.load("s")).toThrow();
	});

	it("seq discontinuity throws (missing or duplicated sequence numbers)", () => {
		const { dir, store } = tempStore();
		store.append("s", "r1", ev(0));
		appendFileSync(join(dir, "s.jsonl"), `${JSON.stringify({ runId: "r1", ts: 1, event: ev(2) })}\n`);
		expect(() => store.load("s")).toThrow(/seq/);

		const dir2 = mkdtempSync(join(tmpdir(), "kiso-sto-"));
		const store2 = new SessionStore(dir2);
		store2.append("s", "r1", ev(0));
		appendFileSync(join(dir2, "s.jsonl"), `${JSON.stringify({ runId: "r1", ts: 1, event: ev(1) })}\n`);
		appendFileSync(join(dir2, "s.jsonl"), `${JSON.stringify({ runId: "r1", ts: 1, event: ev(1) })}\n`);
		expect(() => store2.load("s")).toThrow(/seq/);
	});
});

describe("cross-process single-writer", () => {
	it("a second writer cannot append while the first holds the lock", () => {
		const { dir, store } = tempStore();
		store.append("s", "r1", ev(0));
		const other = new SessionStore(dir);
		expect(() => other.append("s", "r2", ev(1))).toThrow(/locked|writer/);
		// The first writer still owns the session.
		store.append("s", "r1", ev(1));
		expect(store.load("s")).toHaveLength(2);
	});

	it("a stale lock (dead pid) is taken over", () => {
		const { dir } = tempStore();
		writeFileSync(join(dir, "s.lock"), "99999999"); // a pid that is not alive
		const store = new SessionStore(dir);
		store.append("s", "r1", ev(0));
		expect(store.load("s")).toHaveLength(1);
	});

	it("close releases the lock and the fd; appends after close are refused", () => {
		const { dir, store } = tempStore();
		store.append("s", "r1", ev(0));
		store.close("s");
		const other = new SessionStore(dir);
		other.append("s", "r2", ev(1)); // lock released → other writer may proceed
		expect(other.load("s")).toHaveLength(2);
		expect(() => store.append("s", "r3", ev(2))).toThrow(/closed/);
	});
});

describe("EventLog restore validation", () => {
	it("strictly validates seq === 0..N — array length never masks gaps or duplicates", () => {
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
		for await (const _ev of first) {
			await expect(second[Symbol.asyncIterator]().next()).rejects.toThrow(/active run/);
			break;
		}
		// After the first completes, a fresh run is fine.
		for await (const _ev of session.run("three")) {
			// drain
		}
		expect(store.load("s").length).toBeGreaterThan(0);
	});
});
