/**
 * ADR-0058 §2/§6 and ADR-0057 §5, step 3e — a running foreground command
 * becomes a task through the TaskManager's registry: by the person's key
 * at once, or by a steer once the command is AUTO_DETACH_MIN_AGE_MS old.
 * Only what was running when the steer arrived is touched, and a detach
 * happens once — two steers, or a key racing a pending auto-detach, make
 * one promotion. The commands here are fake detachables; the shell's own
 * registration is tools-node's test.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { defineTool, type Event, type ToolContext } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { appendRecord } from "../src/tasks/journal.js";
import { TaskManager, type DetachBy, type TaskBackend } from "../src/tasks/manager.js";

const backend: TaskBackend = {
	async spawn({ dir }) {
		appendRecord(join(dir, "journal.jsonl"), { type: "runner_started", ts: Date.now(), pid: 1, startedAt: "s" });
	},
	identify: () => "verified",
	signalStop: () => {},
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const manager = () => new TaskManager({ root: join(mkdtempSync(join(tmpdir(), "kiso-detach-")), "s.tasks"), backend, pollMs: 60_000 });

describe("3e — the registry", () => {
	it("a registered execution detaches once; detachAll reaches every one; unregister removes it", () => {
		const m = manager();
		const calls: [string, DetachBy][] = [];
		const off = m.registerDetachable("a", { startedAt: 1, detach: (by) => void calls.push(["a", by]) });
		m.registerDetachable("b", { startedAt: 2, detach: (by) => void calls.push(["b", by]) });
		expect(m.detachable()).toEqual([{ executionId: "a", startedAt: 1 }, { executionId: "b", startedAt: 2 }]);
		expect(m.detach("a", "person")).toBe(true);
		expect(m.detach("a", "person")).toBe(false);
		off(); // already gone: a no-op
		expect(m.detachAll("person")).toEqual(["b"]);
		expect(m.detachAll("person")).toEqual([]);
		expect(calls).toEqual([["a", "person"], ["b", "person"]]);
	});
});

/** A tool that runs like a foreground command: registered while it runs,
 *  it returns when it ends (`ms`) or when it is detached. */
function command(m: TaskManager, ms: number, age: number, log: string[]) {
	return defineTool({
		name: "cmd",
		description: "C",
		parameters: { type: "object" },
		execute: (_i, ctx: ToolContext) =>
			new Promise((resolve) => {
				let done = false;
				const finish = (content: string) => {
					if (done) return;
					done = true;
					off();
					resolve({ content, isError: false });
				};
				const off = m.registerDetachable(ctx.executionId!, { startedAt: Date.now() - age, detach: (by) => (log.push(by), finish(`moved: ${by}`)) });
				setTimeout(() => finish("ended"), ms);
			}),
	});
}

async function session(m: TaskManager, tool: ReturnType<typeof command>) {
	const call = { events: [{ type: "tool_call_end" as const, callId: "c", name: "cmd", input: {} }, { type: "stop" as const, reason: "tool_use" as const }] };
	const end = { events: [{ type: "text_delta" as const, text: "ok" }, { type: "stop" as const, reason: "end_turn" as const }] };
	const s = await createAgent({ model: "faux", store: new SessionStore(mkdtempSync(join(tmpdir(), "kiso-detach-s-"))), tools: [tool], adapter: createFauxProvider([call, end, end]) }).session({ id: "s" });
	s.useTasks(m, { windowMs: 20 });
	return s;
}

async function steerDuring(m: TaskManager, ms: number, age: number, steers = 1, during?: () => void) {
	const log: string[] = [];
	const s = await session(m, command(m, ms, age, log));
	const run = s.run("go");
	const events: Event[] = [];
	const drained = (async () => {
		for await (const ev of run) events.push(ev);
	})();
	while (m.detachable().length === 0) await sleep(5);
	const t0 = Date.now();
	for (let i = 0; i < steers; i++) run.steer(`steer ${i + 1}`);
	during?.();
	await drained;
	const result = events.find((e): e is Event & { type: "tool_result" } => e.type === "tool_result")!;
	const text = (c: unknown): string => (typeof c === "string" ? c : (c as { text?: string }[]).map((b) => b.text ?? "").join("\n"));
	const inputs = events.filter((e): e is Event & { type: "user_input" } => e.type === "user_input").map((e) => text(e.content));
	return { log, result: String(result.content), inputs, ms: Date.now() - t0 };
}

describe("ADR-0057 §5 (3e D1) — a steer detaches a command by its age", () => {
	it("a command already 2 s old is detached at once, and the steer lands next", async () => {
		const r = await steerDuring(manager(), 10_000, 5_000);
		expect(r.result).toBe("moved: steer");
		expect(r.inputs).toEqual(["go", "steer 1"]);
		expect(r.ms).toBeLessThan(1_000);
	});

	it("a young command that ends before 2 s is never detached; the steer lands after it", async () => {
		const r = await steerDuring(manager(), 400, 0);
		expect(r.log).toEqual([]);
		expect(r.result).toBe("ended");
		expect(r.inputs).toEqual(["go", "steer 1"]);
	});

	it("a young command still running at 2 s of age is detached then", async () => {
		const r = await steerDuring(manager(), 10_000, 1_500);
		expect(r.result).toBe("moved: steer");
		expect(r.ms).toBeGreaterThanOrEqual(400);
		expect(r.ms).toBeLessThan(1_500);
	});

	it("two steers on one command: one detach, both messages admitted in order", async () => {
		const r = await steerDuring(manager(), 10_000, 5_000, 2);
		expect(r.log).toEqual(["steer"]);
		// ADR-0057 §5: input pending at one site is ONE admission, its lines in arrival order
		expect(r.inputs).toEqual(["go", "steer 1\nsteer 2"]);
	});

	it("the person's key while an auto-detach is pending: one detach, the person's; the timer is a no-op", async () => {
		const m = manager();
		const r = await steerDuring(m, 10_000, 0, 1, () => m.detachAll("person"));
		await sleep(2_200); // past the pending timer
		expect(r.log).toEqual(["person"]);
		expect(r.result).toBe("moved: person");
	});

	it("a command started after the steer is never touched by it", async () => {
		const m = manager();
		const s = await session(m, command(m, 10, 0, []));
		const run = s.run("go");
		run.steer("early"); // nothing is running yet
		const log: string[] = [];
		m.registerDetachable("later", { startedAt: Date.now() - 5_000, detach: (by) => void log.push(by) });
		for await (const _ of run) {
			// drained
		}
		await sleep(2_200);
		expect(log).toEqual([]);
	});
});
