/**
 * ADR-0059 release 1 — the `wait` tool over a fake ShellTasks: the kinds it
 * accepts come from the session (`waitKinds`), a timer needs a positive
 * `ms`, a task wait needs a live task, and the result names the wait and
 * tells the model to stop. No process is spawned here.
 */
import { describe, expect, it } from "vitest";
import type { ToolContext } from "@vincemakes/kiso-core";
import { createCodingTools, waitTool, type ShellTasks } from "../src/index.js";

function fakeTasks(kinds: readonly string[] = ["timer", "task"]): ShellTasks & { waits: unknown[] } {
	const waits: unknown[] = [];
	return {
		waits,
		root: "/tmp/s.tasks",
		start: async () => ({ id: "t1", outputPath: "/tmp/s.tasks/t1/output.log" }),
		adopt: () => {
			throw new Error("not here");
		},
		stop: () => false,
		get: (id) => (id === "t3" ? { state: { kind: "running" } } : id === "t4" ? { state: { kind: "ended" } } : id === "t7" ? { state: { kind: "waiting" }, profile: "wait" } : undefined),
		wait: async (spec) => {
			waits.push(spec);
			return { id: `t${waits.length + 4}`, command: `${spec.source.kind}`, wait: { deadlineAt: 1_700_000_000_000 } };
		},
		waitKinds: () => kinds,
	};
}

const ctx = (sessionId = "s"): ToolContext => ({ sessionId, executionId: "ex-1", signal: new AbortController().signal }) as unknown as ToolContext;

describe("ADR-0059 — the wait tool", () => {
	it("the rent (round wait-r1): the wire entry plus the prompt text stays under 600 bytes — it is paid on every request", () => {
		const w = waitTool({ workspaceRoot: "/tmp", tasks: () => fakeTasks() });
		const wire = JSON.stringify({ name: w.name, description: w.description, input_schema: w.parameters });
		const prompt = (w.promptSnippet ?? "").length + (w.promptGuidelines ?? []).join("\n").length;
		expect(wire.length + prompt).toBeLessThan(600);
		expect(w.promptGuidelines ?? []).toEqual([]);
		expect(Object.keys((w.parameters as { properties: object }).properties)).toEqual(["for", "deadlineMs"]);
	});

	it("is in the coding toolset exactly when tasks are, beside task_stop", () => {
		const names = (opts: Parameters<typeof createCodingTools>[0]) => createCodingTools(opts).map((t) => t.name);
		expect(names({ workspaceRoot: "/tmp" })).not.toContain("wait");
		expect(names({ workspaceRoot: "/tmp", tasks: () => fakeTasks() })).toEqual(expect.arrayContaining(["task_stop", "wait"]));
	});

	it("registers a timer wait for this execution and tells the model to stop", async () => {
		const tasks = fakeTasks();
		const tool = waitTool({ workspaceRoot: "/tmp", tasks: () => tasks });
		const r = await tool.execute({ for: { kind: "timer", ms: 60_000 } }, ctx());
		expect(r.isError).toBe(false);
		expect(r.content).toMatch(/^waiting as t5 \(timer, until 2023-11-14T22:13:20\.000Z\)\. This wait alone wakes you when it fires — register nothing else for it\. Finish your message and stop now/);
		expect(r.content).toMatch(/task_stop t5 cancels it/);
		expect(tasks.waits).toEqual([{ source: { kind: "timer", ms: 60_000 }, executionId: "ex-1" }]);
	});

	it("refuses a kind the session did not register, naming the available ones", async () => {
		const tool = waitTool({ workspaceRoot: "/tmp", tasks: () => fakeTasks(["timer", "task"]) });
		const r = await tool.execute({ for: { kind: "gh-checks", pr: 207 } }, ctx());
		expect(r).toMatchObject({ isError: true, errorKind: "precondition" });
		expect(r.content).toBe('no such wait kind "gh-checks" (available: timer, task)');
	});

	it("a timer needs a positive ms; a task wait needs a task that has not ended", async () => {
		const tool = waitTool({ workspaceRoot: "/tmp", tasks: () => fakeTasks() });
		expect(await tool.execute({ for: { kind: "timer" } }, ctx())).toMatchObject({ isError: true, errorKind: "precondition" });
		expect(await tool.execute({ for: { kind: "timer", ms: -5 } }, ctx())).toMatchObject({ isError: true, errorKind: "precondition" });
		expect(await tool.execute({ for: { kind: "task", id: "t9" } }, ctx())).toMatchObject({ isError: true, content: "no task t9 in this session" });
		expect(await tool.execute({ for: { kind: "task", id: "t4" } }, ctx())).toMatchObject({ isError: true, content: "task t4 has already ended — nothing to wait for" });
		expect((await tool.execute({ for: { kind: "task", id: "t3" } }, ctx())).isError).toBe(false);
	});

	it("W-F1 (round wait-r1): a wait on a wait is refused, and so is a sub-second timer — the message's end is the yield", async () => {
		const tool = waitTool({ workspaceRoot: "/tmp", tasks: () => fakeTasks() });
		expect(await tool.execute({ for: { kind: "task", id: "t7" } }, ctx())).toMatchObject({ isError: true, errorKind: "precondition", content: "t7 is itself a wait: it wakes you by itself when it fires — do not wait on a wait; end your message now" });
		expect(await tool.execute({ for: { kind: "timer", ms: 1 } }, ctx())).toMatchObject({ isError: true, errorKind: "precondition", content: "a timer wait is at least 1000 ms; to yield the turn, end your message — nothing else is needed" });
		expect((await tool.execute({ for: { kind: "timer", ms: 1000 } }, ctx())).isError).toBe(false);
	});

	it("without a session, or a host without waits, the call is a precondition error — never a crash", async () => {
		expect(await waitTool({ workspaceRoot: "/tmp", tasks: () => undefined }).execute({ for: { kind: "timer", ms: 1 } }, ctx())).toMatchObject({ isError: true, errorKind: "precondition", content: "waits are not available in this session" });
		const noWait = { ...fakeTasks() } as Partial<ShellTasks>;
		delete noWait.wait;
		expect(await waitTool({ workspaceRoot: "/tmp", tasks: () => noWait as ShellTasks }).execute({ for: { kind: "timer", ms: 1 } }, ctx())).toMatchObject({ isError: true, errorKind: "precondition" });
	});
});
