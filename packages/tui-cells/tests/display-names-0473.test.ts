/**
 * 0.47.3 — kiso's own tools get screen names (owner, 2026-10-08).
 *
 * `task_stop`, `delegate`, `read_skill` and `ask_user` drew their raw API
 * names as card heads (TASK_STOP, DELEGATE). They are kiso's own tools —
 * the task runner's and the first-party extensions' — so the display-verb
 * table names them; a third party's tool still prints what the model
 * calls. Display only: the model-facing names are untouched.
 */

import { describe, expect, it } from "vitest";
import { displayVerb } from "../src/strings.js";

describe("0.47.3 — the display names of kiso's own tools", () => {
	it("the four first-party tools read as the owner named them", () => {
		expect(displayVerb("task_stop")).toBe("stop task");
		expect(displayVerb("delegate")).toBe("subagents");
		expect(displayVerb("read_skill")).toBe("read skill");
		expect(displayVerb("ask_user")).toBe("ask user");
	});

	it("the card heads uppercase them as every head does", () => {
		expect(["task_stop", "delegate", "read_skill", "ask_user"].map((n) => displayVerb(n).toUpperCase())).toEqual(["STOP TASK", "SUBAGENTS", "READ SKILL", "ASK USER"]);
	});

	it("a tool kiso has never heard of still prints its own name", () => {
		for (const n of ["mcp__github__create_issue", "my_extension_tool", "delegate_v2", "Task"]) expect(displayVerb(n)).toBe(n);
	});

	it("the core six are unchanged", () => {
		expect(["read_file", "list_dir", "search_text", "write_file", "edit_file", "shell"].map(displayVerb)).toEqual(["read", "list", "search", "write", "edit", "shell"]);
	});
});
