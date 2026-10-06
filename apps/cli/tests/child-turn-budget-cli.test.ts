/**
 * ADR-0058 3d (D6) through the CLI's real entry: a background child is
 * `kiso chat <id> --task-file <f> --max-turns N --result-file <r>`. Its
 * budget stops the run cooperatively at a model boundary; one wrap-up
 * request follows (a system input, limited to one request), and the
 * answer lands in result.md with its outcome in result.json — incomplete,
 * never a plain failure. A child that finishes inside its budget writes
 * its answer as completed. The interactive door keeps R3e's no-limit:
 * --max-turns without --task-file is refused.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");
const CALL = (id: string) => ({ events: [{ type: "tool_call_end", callId: id, name: "list_dir", input: {} }, { type: "stop", reason: "tool_use" }] });
const TEXT = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });

function child(script: unknown[], flags: string[]) {
	const { env, dirs } = isolatedEnv({ KISO_MODE: "bypass" });
	const work = mkdtempSync(join(tmpdir(), "kiso-child-ws-"));
	const scriptPath = join(dirs.home, "faux.json");
	writeFileSync(scriptPath, JSON.stringify(script));
	const taskFile = join(dirs.home, "task.txt");
	writeFileSync(taskFile, "map the workspace\n");
	const result = join(work, "result.md");
	const r = spawnSync("node", [CLI, "chat", "sub-c1", "--task-file", taskFile, ...flags.map((f) => f.replace("{result}", result))], { env: { ...env, KISO_FAUX_SCRIPT: scriptPath }, cwd: work, encoding: "utf8", timeout: 60_000 });
	const log = join(dirs.home, "sessions", "sub-c1.jsonl");
	const events = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l !== "").map((l) => (JSON.parse(l) as { event: { type: string; source?: string; content?: unknown; outcome?: { kind: string } } }).event) : [];
	return { r, result, events };
}

describe("ADR-0058 3d (D6) — a background child's turn budget", () => {
	it("the budget is spent: one wrap-up request, its answer in result.md, outcome incomplete", () => {
		const { r, result, events } = child([CALL("a"), CALL("b"), TEXT("found the entry point\n\nUNRESOLVED\n- the tests")], ["--max-turns", "2", "--result-file", "{result}"]);
		expect(r.status).toBe(0);
		const inputs = events.filter((e) => e.type === "user_input");
		expect(inputs.map((e) => e.source ?? "user")).toEqual(["user", "system"]);
		expect(String(inputs[1]!.content)).toMatch(/turn budget of 2 model requests is spent/);
		expect(events.filter((e) => e.type === "terminal").map((e) => e.outcome!.kind)).toEqual(["max_turns", "completed"]);
		expect(readFileSync(result, "utf8")).toBe("found the entry point\n\nUNRESOLVED\n- the tests\n");
		expect(JSON.parse(readFileSync(join(result, "..", "result.json"), "utf8"))).toEqual({ outcome: "incomplete", requests: 3, budget: 2 });
	}, 60_000);

	it("the wrap-up itself never gets a second request", () => {
		const { events } = child([CALL("a"), CALL("b"), CALL("c"), TEXT("never asked")], ["--max-turns", "2", "--result-file", "{result}"]);
		expect(events.filter((e) => e.type === "terminal").map((e) => e.outcome!.kind)).toEqual(["max_turns", "max_turns"]);
		expect(events.filter((e) => e.type === "stop")).toHaveLength(3);
	}, 60_000);

	it("a child that finishes inside its budget: its answer, outcome completed", () => {
		const { r, result } = child([CALL("a"), TEXT("all mapped")], ["--max-turns", "5", "--result-file", "{result}"]);
		expect(r.status).toBe(0);
		expect(readFileSync(result, "utf8")).toBe("all mapped\n");
		expect(JSON.parse(readFileSync(join(result, "..", "result.json"), "utf8"))).toEqual({ outcome: "completed", requests: 2, budget: 5 });
	}, 60_000);

	it("--max-turns and --result-file without --task-file are refused (the interactive door has no turn limit)", () => {
		const { env } = isolatedEnv({ KISO_MODE: "bypass" });
		for (const flags of [["--max-turns", "3"], ["--result-file", "/tmp/x.md"]]) {
			const r = spawnSync("node", [CLI, "chat", "sub-x", ...flags], { env, encoding: "utf8", input: "", timeout: 30_000 });
			expect(r.status).toBe(2);
			expect(r.stderr).toMatch(/needs --task-file/);
		}
	}, 60_000);
});
