/**
 * ADR-0058 Amendment 8 — `unknown` means kiso lost track of a task, and
 * only that. A runner's identity that cannot be READ for a moment (the
 * probe itself failed — a loaded machine) is not a lost runner: a task
 * last verified running keeps that reading until the next check. And a
 * task that was lost and then records its end is still announced, so a
 * model told "unknown" learns how it ended. The stop path is unchanged: a
 * runner not verified NOW is never signalled.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendRecord } from "../src/tasks/journal.js";
import { TaskManager, type RunnerIdentity, type TaskBackend, type TaskTransition } from "../src/tasks/manager.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A backend whose identity answers come from `answer()`, and which
 *  records every signal it is asked to send. */
function backend(answer: () => RunnerIdentity, startedAt = "start-1") {
	const signalled: number[] = [];
	const b: TaskBackend = {
		async spawn({ dir }) {
			appendRecord(join(dir, "journal.jsonl"), { type: "runner_started", ts: Date.now(), pid: 4321, startedAt });
			appendRecord(join(dir, "journal.jsonl"), { type: "command_started", ts: Date.now() });
		},
		identify: () => answer(),
		signalStop: (pid) => void signalled.push(pid),
	};
	return { b, signalled };
}

function setup(b: TaskBackend) {
	const heard: TaskTransition[] = [];
	const manager = new TaskManager({ root: join(mkdtempSync(join(tmpdir(), "kiso-lost-")), "s.tasks"), backend: b, pollMs: 10, identifyEveryMs: 0, onTransition: (_t, tr) => heard.push(tr) });
	return { manager, heard };
}

describe("Amendment 8 — a probe that fails for a moment is not a lost runner", () => {
	it("verified, then unreadable once, then verified: the task reads running throughout, and no unknown is announced", async () => {
		const answers: RunnerIdentity[] = ["verified", "verified", "unverifiable", "verified"];
		let i = 0;
		const { b } = backend(() => answers[Math.min(i++, answers.length - 1)]!);
		const { manager, heard } = setup(b);
		const t = await manager.start({ command: "npm run dev", cwd: "/", executionId: "ex-1" });
		manager.observe();
		for (let n = 0; n < 6; n++) {
			expect(manager.get(t.id)!.state.kind).toBe("running");
			await sleep(15);
		}
		expect(heard).toEqual([]);
		manager.close();
	});

	it("never verified (the first reading fails, or no start time was recorded): unknown, as before", async () => {
		const first = backend(() => "unverifiable");
		const a = setup(first.b);
		const t = await a.manager.start({ command: "x", cwd: "/" });
		expect(a.manager.get(t.id)!.state.kind).toBe("unknown");
		a.manager.close();
		// a runner whose start time could not be recorded is never verifiable
		let calls = 0;
		const blank = backend(() => (calls++ === 0 ? "verified" : "unverifiable"), "");
		const c = setup(blank.b);
		const u = await c.manager.start({ command: "x", cwd: "/" });
		c.manager.get(u.id);
		expect(c.manager.get(u.id)!.state.kind).toBe("unknown");
		c.manager.close();
	});

	it("a runner verifiably gone is lost at once, and that verdict is final", async () => {
		let gone = false;
		const { b } = backend(() => (gone ? "gone" : "verified"));
		const { manager } = setup(b);
		const t = await manager.start({ command: "x", cwd: "/" });
		expect(manager.get(t.id)!.state.kind).toBe("running");
		gone = true;
		expect(manager.get(t.id)!.state.kind).toBe("unknown");
		gone = false; // a pid that comes back is a stranger's
		expect(manager.get(t.id)!.state.kind).toBe("unknown");
		manager.close();
	});

	it("the stop path still checks fresh: a runner not verifiable NOW is never signalled", async () => {
		const answers: RunnerIdentity[] = ["verified", "unverifiable"];
		let i = 0;
		const { b, signalled } = backend(() => answers[Math.min(i++, answers.length - 1)]!);
		const { manager } = setup(b);
		const t = await manager.start({ command: "x", cwd: "/" });
		expect(manager.get(t.id)!.state.kind).toBe("running"); // verified once
		manager.stop(t.id, "model");
		expect(signalled).toEqual([]);
		manager.close();
	});
});

describe("Amendment 8 — a lost task that records its end is still announced", () => {
	it("unknown, then a terminal: the end is announced after the unknown", async () => {
		let gone = false;
		const { b } = backend(() => (gone ? "gone" : "verified"));
		const { manager, heard } = setup(b);
		const t = await manager.start({ command: "x", cwd: "/", executionId: "ex-1" });
		manager.observe();
		await sleep(30);
		gone = true;
		await sleep(40);
		expect(heard).toEqual(["unknown"]);
		appendRecord(join(manager.root, t.id, "journal.jsonl"), { type: "terminal", ts: Date.now(), exitCode: 0, signal: null });
		await sleep(40);
		expect(heard).toEqual(["unknown", "ended"]);
		expect(manager.get(t.id)!.state.kind).toBe("ended");
		manager.close();
	});
});
