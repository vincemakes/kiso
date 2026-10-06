/**
 * ADR-0058 Amendment 8 — `unknown` means kiso lost track of a task, and
 * only that. A runner's identity that cannot be READ for a moment (the
 * probe itself failed — a loaded machine) is not a lost runner: a task
 * last verified running keeps that reading until the next check. And a
 * task that was lost and then records its end is still announced, so a
 * model told "unknown" learns how it ended. The stop path is unchanged: a
 * runner not verified NOW is never signalled.
 *
 * And the person hears of a loss when kiso concludes it (rev 2): the
 * delivery tells its host, through `onLost`, of every loss the model has
 * not been told of — at startup and live — while the model's notice keeps
 * its own turn. A loss a tool result already reported is never told.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendRecord } from "../src/tasks/journal.js";
import { TaskDelivery } from "../src/tasks/delivery.js";
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

describe("Amendment 8 (rev 2) — the person hears of a loss when kiso concludes it", () => {
	const delivery = (manager: TaskManager, events: unknown[] = []) => {
		const told: string[][] = [];
		const d = new TaskDelivery({ manager, events: () => events as never, liveRun: () => undefined, onLost: (ids) => void told.push([...ids]) } as never);
		return { d, told };
	};

	it("at startup: a loss the model was not told of is told at once; one it was told of is not", async () => {
		const { b } = backend(() => "gone");
		const { manager } = setup(b);
		const t = await manager.start({ command: "npm run dev", cwd: "/", executionId: "ex-1" });
		expect(manager.get(t.id)!.state.kind).toBe("unknown");
		const fresh = delivery(manager);
		expect(fresh.told).toEqual([[t.id]]);
		fresh.d.close();
		const receipt = { type: "user_input", content: "n", source: "system", via: { kind: "tasks", items: [{ taskId: t.id, transition: "unknown" }] }, seq: 0 };
		const known = delivery(manager, [receipt]);
		expect(known.told).toEqual([]);
		known.d.close();
		manager.close();
	});

	it("live: a loss is told once, at once — no run has carried its notice yet", async () => {
		let gone = false;
		const { b } = backend(() => (gone ? "gone" : "verified"));
		const { manager } = setup(b);
		const { d, told } = delivery(manager);
		const t = await manager.start({ command: "x", cwd: "/", executionId: "ex-1" });
		manager.observe();
		await sleep(30);
		expect(told).toEqual([]);
		gone = true;
		await sleep(60);
		expect(told).toEqual([[t.id]]);
		d.close();
		manager.close();
	});

	it("a loss a tool result reported (claimed) is never told", async () => {
		let gone = false;
		const { b } = backend(() => (gone ? "gone" : "verified"));
		const { manager } = setup(b);
		const { d, told } = delivery(manager);
		const t = await manager.start({ command: "x", cwd: "/", executionId: "ex-1" });
		manager.observe();
		const waited = manager.awaitSettled(t.id, "end", 2_000, { executionId: "ex-stop" });
		gone = true;
		const settled = await waited;
		expect(settled.info.state.kind).toBe("unknown");
		expect(settled.claimed).toBe(true);
		await sleep(60);
		expect(told).toEqual([]);
		// and a later delivery built from the journal does not tell it either
		const later = delivery(manager);
		expect(later.told).toEqual([]);
		later.d.close();
		d.close();
		manager.close();
	});
});
