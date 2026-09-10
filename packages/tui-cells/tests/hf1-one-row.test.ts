/**
 * HF-1 (0.32.1) — a head row is ONE row, whatever the model wrote.
 *
 * The owner's 0.32.0 dogfood: the model issued `python3 - <<'EOF' …` — a
 * multi-line shell command — and the running card's head row carried the
 * command's newlines into the compositor, which threw invariant ①b in the
 * field and the process died. The head-row builders (`toolTarget`, the
 * summary detail) must PROJECT a line break to a visible mark, never pass
 * it through: a row is one physical row by construction, not by luck.
 */
import { describe, expect, it } from "vitest";
import { renderToolSummary, toolTarget } from "../src/render.js";

const HEREDOC = "python3 - <<'EOF'\nimport json\nprint(1)\nEOF";

describe("HF-1 — the head-row builders project line breaks", () => {
	it("toolTarget(shell) with a heredoc command is one row, the breaks shown as ⏎", () => {
		const t = toolTarget("shell", { command: HEREDOC });
		expect(t).not.toMatch(/[\n\r]/);
		expect(t).toContain("python3 - <<'EOF'⏎import json⏎print(1)⏎EOF");
	});
	it("a CRLF break and a bare CR are one mark each, a tab is a space", () => {
		expect(toolTarget("shell", { command: "a\r\nb\rc\td" })).toBe("a⏎b⏎c d");
	});
	it("a path with a line break does not get to be two rows either", () => {
		expect(toolTarget("read_file", { path: "odd\nname.txt" })).toBe("odd⏎name.txt");
	});
	it("the settled summary of a heredoc shell call is one row", () => {
		const row = renderToolSummary("shell", { command: HEREDOC }, { content: "1\n", isError: false });
		expect(row).not.toMatch(/[\n\r]/);
		expect(row).toContain("⏎");
	});
	it("the denied row (W19) is one row too", () => {
		const row = renderToolSummary("shell", { command: HEREDOC }, { content: "", isError: true }, "denied by the breaker");
		expect(row).not.toMatch(/[\n\r]/);
	});
});
