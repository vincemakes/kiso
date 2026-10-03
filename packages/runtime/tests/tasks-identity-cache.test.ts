/**
 * Windows P6 / ADR-0058 §6 — checking a runner's identity starts a process
 * (`ps` on POSIX, a PowerShell on win32), so the TaskManager does not
 * repeat it on every read: a task with a terminal is never identified (its
 * verdict cannot depend on it), "gone" is final, and a live verdict is
 * reused for `identifyEveryMs`. The journal itself is still read every
 * time, so an end is seen at once. The stated worst case: a runner that
 * dies WITHOUT a terminal reads `unknown` only once its cached verdict
 * expires. A stop always checks afresh — it must never signal a pid that
 * is someone else's now.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendRecord } from "../src/tasks/journal.js";
import { TaskManager, type RunnerIdentity, type TaskBackend } from "../src/tasks/manager.js";

function counting(): { backend: TaskBackend; calls: () => number; set: (v: RunnerIdentity) => void; signals: number[] } {
	let n = 0;
	let verdict: RunnerIdentity = "verified";
	const signals: number[] = [];
	return {
		backend: {
			async spawn({ dir }) {
				appendRecord(join(dir, "journal.jsonl"), { type: "runner_started", ts: Date.now(), pid: 4242, startedAt: "s-4242" });
				appendRecord(join(dir, "journal.jsonl"), { type: "command_started", ts: Date.now() });
			},
			identify: () => {
				n += 1;
				return verdict;
			},
			signalStop: (pid) => void signals.push(pid),
		},
		calls: () => n,
		set: (v) => void (verdict = v),
		signals,
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = () => join(mkdtempSync(join(tmpdir(), "kiso-identity-")), "s.tasks");

describe("Windows P6 — a runner's identity is not checked on every read", () => {
	it("a task that has ended is never identified, however often it is listed", async () => {
		const b = counting();
		const m = new TaskManager({ root: root(), backend: b.backend, pollMs: 60_000 });
		for (let i = 0; i < 5; i++) {
			const t = await m.start({ command: `job ${i}`, cwd: "/" });
			appendRecord(join(m.root, t.id, "journal.jsonl"), { type: "terminal", ts: Date.now(), exitCode: 0, signal: null });
		}
		const before = b.calls();
		for (let i = 0; i < 10; i++) {
			m.list();
			m.get("t3");
		}
		expect(b.calls() - before).toBe(0);
		m.close();
	});

	it("a live runner is identified at most once per window; the journal is still read every time", async () => {
		const b = counting();
		const m = new TaskManager({ root: root(), backend: b.backend, pollMs: 60_000, identifyEveryMs: 200 });
		const t = await m.start({ command: "serve", cwd: "/" });
		const before = b.calls();
		for (let i = 0; i < 20; i++) expect(m.get(t.id)!.state.kind).toBe("running");
		expect(b.calls() - before).toBeLessThanOrEqual(1);
		appendRecord(join(m.root, t.id, "journal.jsonl"), { type: "terminal", ts: Date.now(), exitCode: 0, signal: null });
		expect(m.get(t.id)!.state.kind).toBe("ended"); // an end is seen at once, cache or not
		m.close();
	});

	it("the worst case, stated: a runner that dies without a terminal reads unknown once its verdict expires", async () => {
		const b = counting();
		const m = new TaskManager({ root: root(), backend: b.backend, pollMs: 60_000, identifyEveryMs: 150 });
		const t = await m.start({ command: "serve", cwd: "/" });
		expect(m.get(t.id)!.state.kind).toBe("running");
		b.set("gone"); // the runner dies, no terminal
		expect(m.get(t.id)!.state.kind).toBe("running"); // still inside the window
		await sleep(200);
		expect(m.get(t.id)!.state.kind).toBe("unknown");
		const after = b.calls();
		await sleep(200);
		m.get(t.id);
		m.list();
		expect(b.calls()).toBe(after); // "gone" is final
		m.close();
	});

	it("a stop checks afresh and never signals a runner that is gone now", async () => {
		const b = counting();
		const m = new TaskManager({ root: root(), backend: b.backend, pollMs: 60_000, identifyEveryMs: 60_000 });
		const t = await m.start({ command: "serve", cwd: "/" });
		expect(m.get(t.id)!.state.kind).toBe("running"); // "verified" cached for a minute
		b.set("gone");
		expect(m.stop(t.id, "person")).toBe(false);
		expect(b.signals).toEqual([]);
		m.close();
	});
});
