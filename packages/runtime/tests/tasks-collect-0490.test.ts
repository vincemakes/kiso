/**
 * 0.49.0 B — a writer's end is its collection. A task started with
 * `agent.collect` whose process has ended is COLLECTING until its journal
 * holds `collected`: not announced, not settled, not ended for its group.
 * The manager calls the host's collector once per such task (the watcher,
 * a wait, or `collectPending` at open); a collector that throws, or records
 * nothing, still ends it — as a failed collection, never stuck.
 */
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendRecord } from "../src/tasks/journal.js";
import { endTransitionOf, isCollecting, TaskManager, type TaskBackend, type TaskInfo } from "../src/tasks/manager.js";

function fakeBackend(): TaskBackend {
	let pid = 100;
	return {
		async spawn({ dir }) {
			pid += 1;
			appendRecord(join(dir, "journal.jsonl"), { type: "runner_started", ts: Date.now(), pid, startedAt: `start-${pid}` });
			appendRecord(join(dir, "journal.jsonl"), { type: "command_started", ts: Date.now() });
		},
		identify: (p, startedAt) => (startedAt === `start-${p}` ? "verified" : "gone"),
		signalStop: () => {},
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const end = (m: TaskManager, id: string, exitCode = 0) => appendRecord(join(m.root, id, "journal.jsonl"), { type: "terminal", ts: Date.now(), exitCode, signal: null });
const collected = (m: TaskManager, id: string, outcome = "collected") => appendFileSync(join(m.root, id, "journal.jsonl"), `${JSON.stringify({ type: "collected", ts: Date.now(), outcome })}\n`);

function manager(collect?: (info: TaskInfo, m: TaskManager) => Promise<void>) {
	const root = join(mkdtempSync(join(tmpdir(), "kiso-collect-")), "s.tasks");
	const m: TaskManager = new TaskManager({ root, backend: fakeBackend(), pollMs: 10, ...(collect !== undefined ? { collect: (info) => collect(info, m) } : {}) });
	return m;
}

const writer = (m: TaskManager) => m.start({ command: "implementer: change it", cwd: "/", executionId: "ex-1", agent: { role: "implementer", session: "sub-w", collect: true } });

describe("0.49.0 B — a writer has not ended until it is collected", () => {
	it("an ended writer reads as collecting: no end transition, not announced, not settled", async () => {
		const m = manager();
		const heard: string[] = [];
		m.subscribe((t, tr) => void heard.push(`${t.id}:${tr}`));
		m.observe();
		const t = await writer(m);
		end(m, t.id);
		await sleep(60);
		const info = m.get(t.id)!;
		expect(info.state.kind).toBe("ended");
		expect(isCollecting(info)).toBe(true);
		expect(endTransitionOf(info)).toBeNull();
		expect(heard).toEqual([]);
		const w = await m.awaitSettled(t.id, "end", 150);
		expect(w.settled).toBe(false);
		collected(m, t.id);
		await sleep(60);
		expect(endTransitionOf(m.get(t.id)!)).toBe("exited");
		expect(m.get(t.id)!.collection).toEqual({ outcome: "collected" });
		expect(heard).toEqual([`${t.id}:ended`]);
		m.close();
	});

	it("a reader is unchanged: its process's end is its end", async () => {
		const m = manager();
		const t = await m.start({ command: "explorer: look", cwd: "/", agent: { role: "explorer", session: "sub-r" } });
		end(m, t.id);
		expect(endTransitionOf(m.get(t.id)!)).toBe("exited");
		expect(isCollecting(m.get(t.id)!)).toBe(false);
		m.close();
	});

	it("the watcher calls the collector exactly once, however many polls pass", async () => {
		const calls: string[] = [];
		const m = manager(async (info, mm) => {
			calls.push(info.id);
			await sleep(80);
			collected(mm, info.id);
		});
		m.observe();
		const t = await writer(m);
		end(m, t.id);
		await sleep(250);
		expect(calls).toEqual([t.id]);
		expect(endTransitionOf(m.get(t.id)!)).toBe("exited");
		m.close();
	});

	it("a wait on a writer drives its collection too — the join's own path, with no watcher running", async () => {
		const m = manager(async (info, mm) => collected(mm, info.id));
		const t = await writer(m);
		end(m, t.id);
		const w = await m.awaitSettled(t.id, "end", 2_000, { executionId: "ex-1", agentJoin: true });
		expect(w).toMatchObject({ settled: true, claimed: true });
		m.close();
	});

	it("a collector that throws, or records nothing, still ends the writer — as a failed collection, with the reason", async () => {
		const m1 = manager(async () => {
			throw new Error("disk full");
		});
		const a = await writer(m1);
		end(m1, a.id);
		await m1.collectPending();
		expect(m1.get(a.id)!.collection).toEqual({ outcome: "failed", reason: "disk full" });
		expect(endTransitionOf(m1.get(a.id)!)).toBe("exited");
		m1.close();

		const m2 = manager(async () => {});
		const b = await writer(m2);
		end(m2, b.id);
		await m2.collectPending();
		expect(m2.get(b.id)!.collection).toEqual({ outcome: "failed", reason: "the collector recorded nothing" });
		m2.close();
	});

	it("collectPending at open collects every writer that ended uncollected, and waits for each", async () => {
		const m = manager(async (info, mm) => {
			await sleep(50);
			collected(mm, info.id);
		});
		const a = await writer(m);
		const b = await writer(m);
		end(m, a.id);
		end(m, b.id, 1);
		await m.collectPending();
		expect([endTransitionOf(m.get(a.id)!), endTransitionOf(m.get(b.id)!)]).toEqual(["exited", "failed"]);
		m.close();
	});

	it("a stop on a collecting writer is refused: its process is gone, never signalled", async () => {
		const m = manager();
		const t = await writer(m);
		end(m, t.id);
		expect(m.stop(t.id, "model")).toBe(false);
		m.close();
	});

	it("an unknown writer is never collected (P6): its runner vanished without a terminal", async () => {
		const calls: string[] = [];
		const m = manager(async (info) => void calls.push(info.id));
		const t = await writer(m);
		appendRecord(join(m.root, t.id, "journal.jsonl"), { type: "stop_unconfirmed", ts: Date.now(), pids: [1] });
		await m.collectPending();
		expect(calls).toEqual([]);
		m.close();
	});
});
