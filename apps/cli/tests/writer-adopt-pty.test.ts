/**
 * 0.49.0 B through a real terminal: an implementer joined, collected, and
 * adopted. The model delegates an implementer; the call returns its handoff
 * — the patch by path and the adoption command, never the patch inline;
 * the model runs that command through the shell tool (the person's
 * approval rules cover it, as any shell call); the workspace then holds
 * the child's change, merged with the person's own uncommitted edit.
 *
 * The parent is scripted (faux); its delegate and shell calls are real; the
 * child is a scripted process (KISO_SUBAGENT_BIN) that edits its snapshot.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const CHILD = `
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const at = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
writeFileSync("notes.txt", readFileSync("notes.txt", "utf8").replace("line 8", "line 8 FROM-THE-CHILD"));
const result = at("--result-file");
writeFileSync(result, "edited notes.txt\\n\\nUNRESOLVED\\nnone\\n");
writeFileSync(join(dirname(result), "result.json"), JSON.stringify({ outcome: "completed", endedBy: "completed", requests: 2, toolCalls: 1, model: "m", profile: null }));
`;

type Ev = { type: string; content?: unknown; name?: string; input?: { command?: string } };
const eventsOf = (home: string, id: string): Ev[] =>
	readFileSync(join(home, "sessions", `${id}.jsonl`), "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => (JSON.parse(l) as { event: Ev }).event);
const text = (t: string) => ({ events: [{ type: "text_delta", text: t }, { type: "stop", reason: "end_turn" }] });

describe("0.49.0 B — a writer is collected, and adopted through the shell", () => {
	it("the handoff names the patch and its command; running it merges the child's change with the person's uncommitted edit", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-adopt-pty-"));
		const ws = join(dir, "ws");
		mkdirSync(ws);
		writeFileSync(join(dir, "child.mjs"), CHILD, "utf8");
		execFileSync("git", ["init", "-q"], { cwd: ws });
		writeFileSync(join(ws, "notes.txt"), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
		execFileSync("git", ["add", "-A"], { cwd: ws });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: ws });
		// the person's own edit, uncommitted, made before the delegation
		writeFileSync(join(ws, "notes.txt"), readFileSync(join(ws, "notes.txt"), "utf8").replace("line 2", "line 2 THE-PERSON"));
		const { env, dirs } = isolatedEnv({ KISO_MODE: "bypass", KISO_SUBAGENT_BIN: join(dir, "child.mjs") });
		const taskDir = join(dirs.home, "sessions", "adopt-a.tasks", "t1");
		const delegateCall = { events: [{ type: "tool_call_end", callId: "d1", name: "delegate", input: { tasks: [{ role: "implementer", task: "edit notes.txt" }] } }, { type: "stop", reason: "tool_use" }] };
		const applyCall = { events: [{ type: "tool_call_end", callId: "s1", name: "shell", input: { command: `node '${CLI}' apply-patch '${taskDir}'` } }, { type: "stop", reason: "tool_use" }] };
		env.KISO_FAUX_SCRIPT = fauxScript([delegateCall, applyCall, text("ADOPTED-IT"), ...spares(3)]);
		ptyRun(["chat", "adopt-a"], env as NodeJS.ProcessEnv, {
			cwd: ws,
			feeds: [
				["/mode to switch", "go\r"],
				["ADOPTED-IT", "exit\r"],
			],
			timeout: 90,
		});
		const events = eventsOf(dirs.home, "adopt-a");
		const results = events.filter((e) => e.type === "tool_result").map((e) => String(e.content));
		expect(results[0]).toContain(`patch: ${join(taskDir, "patch.diff")} (1 file: notes.txt)`);
		expect(results[0]).toMatch(/\n {2}apply: node \S+ apply-patch \S+t1/);
		expect(results[0]).not.toContain("FROM-THE-CHILD");
		expect(results[1]).toMatch(/apply-patch: adopted 1 file: notes\.txt/);
		const notes = readFileSync(join(ws, "notes.txt"), "utf8");
		expect(notes).toContain("line 2 THE-PERSON");
		expect(notes).toContain("line 8 FROM-THE-CHILD");
		// the person's index was never touched: notes.txt is still only modified, unstaged
		expect(execFileSync("git", ["--no-optional-locks", "status", "--porcelain"], { cwd: ws, encoding: "utf8" })).toBe(" M notes.txt\n");
	}, 180_000);
});
