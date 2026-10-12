/**
 * ADR-0059 Amendment 1 (2026-10-07, the owner's ruling): the `wait` tool is
 * withdrawn. Its cases are already tasks — a foreground command that
 * outlives its wait becomes a background task and wakes the session when
 * it ends (`gh pr checks --watch`, `sleep`, a polling script) — and the
 * tool's rent (+150 tokens on every request) bought little beyond that.
 * The chain budget that shipped with it stays (ADR-0058 Amendment 9).
 *
 * This pins the tool table: with tasks wired, the coding tools are the six
 * built-ins, `task_stop` and (Result Inspect) `inspect_result`, and nothing
 * else — no `wait`. Without tasks, neither of the last two: a session
 * without tasks pays nothing for them.
 */
import { describe, expect, it } from "vitest";
import { createCodingTools, type ShellTasks } from "../src/index.js";

const tasks = { root: "/tmp/s.tasks", start: async () => ({ id: "t1", outputPath: "/x" }), adopt: () => ({}) as never, stop: () => false, get: () => undefined } as unknown as ShellTasks;

describe("ADR-0059 Amendment 1 — the wait tool is withdrawn", () => {
	it("with tasks wired the table is the six built-ins, task_stop and inspect_result — no wait", () => {
		expect(createCodingTools({ workspaceRoot: "/tmp", tasks: () => tasks }).map((t) => t.name)).toEqual(["read_file", "list_dir", "search_text", "write_file", "edit_file", "shell", "task_stop", "inspect_result"]);
	});
	it("without tasks the table is the six built-ins", () => {
		expect(createCodingTools({ workspaceRoot: "/tmp" }).map((t) => t.name)).toEqual(["read_file", "list_dir", "search_text", "write_file", "edit_file", "shell"]);
	});
});
