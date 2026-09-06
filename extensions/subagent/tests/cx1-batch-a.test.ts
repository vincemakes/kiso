/**
 * CX-1 Batch A — the subagent's identity (F6) and preservation (F2)
 * invariants, red first.
 *
 * F6: two `delegate` invocations never share a child session; an
 * extraction reports the terminal of the run this invocation launched,
 * located by identity, never by position. The child log must hold
 * exactly one run — more is `ambiguous`, failed.
 *
 * F2: a worktree is removed only when there were provably no changes.
 * `collected` is earned (patch file closed AND git exited 0); a
 * collection failure preserves the worktree and reports FAILED; the
 * patch streams to a file, so a 1.2 MB change no longer hits the
 * 1 MiB `execFileSync` cap that used to read as "no changes" and
 * delete the work.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import createSubagentExtension, { extractChildResult } from "../dist/kiso-subagent.mjs";

const CLI = join(fileURLToPath(new URL("../../../apps/cli", import.meta.url)), "dist", "index.js");
const ctx = { signal: new AbortController().signal };

function fauxEnv(extra: Record<string, string> = {}): void {
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.OPENAI_API_KEY;
	delete process.env.KISO_SUBAGENT_DEPTH;
	Object.assign(process.env, { KISO_SUBAGENT_BIN: CLI, ...extra });
}

async function delegateWith(tasks: { role: string; task: string }[], home: string): Promise<{ content: string; isError: boolean }> {
	fauxEnv({ KISO_HOME: home });
	const ext = await createSubagentExtension();
	const delegate = ext.tools!.find((t) => t.name === "delegate")!;
	return (await delegate.execute({ tasks }, ctx)) as { content: string; isError: boolean };
}

/** A parent git repo with one commit, its KISO_HOME beside it. */
function repo(): { dir: string; home: string } {
	const dir = mkdtempSync(join(tmpdir(), "kiso-cx1a-"));
	const home = join(dir, "home");
	mkdirSync(join(home, "sessions"), { recursive: true });
	execFileSync("git", ["init", "-q", dir]);
	execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
	execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
	writeFileSync(join(dir, "base.txt"), "base", "utf8");
	execFileSync("git", ["-C", dir, "add", "."]);
	execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
	return { dir, home };
}

const turn = (events: object[]) => ({ events });
const done = turn([{ type: "stop", reason: "end_turn" }]);

let cwd0: string;
beforeEach(() => {
	cwd0 = process.cwd();
});
afterEach(() => {
	process.chdir(cwd0);
	delete process.env.KISO_FAUX_SCRIPT;
});

describe("CX-1 F6 — a delegation invocation has its own identity", () => {
	it("three invocations → three child sessions, three manifests; none reopened", async () => {
		const { dir, home } = repo();
		const script = join(dir, "faux.json");
		writeFileSync(script, JSON.stringify([turn([{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }])]), "utf8");
		fauxEnv({ KISO_HOME: home, KISO_FAUX_SCRIPT: script });
		process.chdir(dir);
		for (let i = 0; i < 3; i += 1) {
			const r = await delegateWith([{ role: "explorer", task: `look ${i}` }], home);
			expect(r.isError, r.content).toBe(false);
		}
		const sessions = readdirSync(join(home, "sessions")).filter((f) => f.startsWith("sub-") && f.endsWith(".jsonl"));
		expect(sessions).toHaveLength(3); // one child session per invocation — never the same file reopened
		const manifests = readdirSync(join(home, "sessions", "subagent")).filter((f) => f.endsWith(".json"));
		expect(manifests).toHaveLength(3);
		for (const m of manifests) {
			const rec = JSON.parse(readFileSync(join(home, "sessions", "subagent", m), "utf8")) as { childId: string; role: string; parentId: string };
			expect(sessions).toContain(`${rec.childId}.jsonl`); // the manifest binds the identity to its child
			expect(rec.role).toBe("explorer");
		}
	});

	it("a child log with two runs is `ambiguous` — the result is located by identity, never by position", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-cx1a-x-"));
		const sessionsDir = join(dir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const childId = "sub-p-deadbeef-1-explorer";
		const rec = (runId: string, event: object) => JSON.stringify({ runId, ts: 1, event });
		writeFileSync(
			join(sessionsDir, `${childId}.jsonl`),
			[
				rec("run-a", { type: "user_input", content: "first", seq: 0 }),
				rec("run-a", { type: "text_delta", text: "done first", seq: 1 }),
				rec("run-a", { type: "terminal", outcome: { kind: "completed" }, seq: 2 }),
				rec("run-b", { type: "user_input", content: "second", seq: 3 }),
				rec("run-b", { type: "terminal", outcome: { kind: "error" }, seq: 4 }),
			].join("\n") + "\n",
			"utf8",
		);
		const r = await extractChildResult(sessionsDir, childId, "exit 0");
		expect(r.failed).toBe(true);
		expect(r.outcome).toBe("ambiguous"); // never "completed" borrowed from the first run
	});
});

describe("CX-1 F2 — the implementer's output is never deleted on a collection failure", () => {
	it("a 1.2 MB new file: `collected`, the worktree KEPT, the patch streamed to a file byte-equal to git diff", async () => {
		const { dir, home } = repo();
		const big = "x".repeat(1_200_000);
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				turn([{ type: "tool_call_end", callId: "w1", name: "write_file", input: { path: "big.txt", content: big, expectedRevision: "absent" } }, { type: "stop", reason: "tool_use" }]),
				done,
			]),
			"utf8",
		);
		fauxEnv({ KISO_HOME: home, KISO_FAUX_SCRIPT: script });
		process.chdir(dir);
		const r = await delegateWith([{ role: "implementer", task: "write a big file" }], home);
		expect(r.isError, r.content).toBe(false);
		expect(r.content).not.toContain("FAILED");
		const kept = /worktree kept at: (.+)/.exec(r.content);
		expect(kept, r.content).not.toBeNull();
		expect(existsSync(join(kept![1]!, "big.txt"))).toBe(true); // the work survived
		const patch = /patch: (.+)/.exec(r.content);
		expect(patch, r.content).not.toBeNull();
		const expected = execFileSync("git", ["-C", kept![1]!, "diff"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		expect(readFileSync(patch![1]!, "utf8")).toBe(expected); // byte-equal, uncapped
		expect(r.content).not.toContain(big.slice(0, 200)); // a 1.2 MB patch is NOT inlined
	});

	it("a collection failure: `failed`, the worktree PRESERVED, the section says so", async () => {
		const { dir, home } = repo();
		const script = join(dir, "faux.json");
		// the child writes, then breaks its own worktree's git link — the
		// collection that follows must fail loudly, not read as "no changes"
		writeFileSync(
			script,
			JSON.stringify([
				turn([{ type: "tool_call_end", callId: "w1", name: "write_file", input: { path: "work.txt", content: "valuable", expectedRevision: "absent" } }, { type: "stop", reason: "tool_use" }]),
				turn([{ type: "tool_call_end", callId: "s1", name: "shell", input: { command: "rm -f .git" } }, { type: "stop", reason: "tool_use" }]),
				done,
			]),
			"utf8",
		);
		fauxEnv({ KISO_HOME: home, KISO_FAUX_SCRIPT: script });
		process.chdir(dir);
		const r = await delegateWith([{ role: "implementer", task: "write then break" }], home);
		expect(r.content).toContain("FAILED");
		expect(r.content).toMatch(/collect/i); // the failure names the collection, not the child's work
		const kept = /worktree kept at: (.+)/.exec(r.content);
		expect(kept, r.content).not.toBeNull();
		expect(readFileSync(join(kept![1]!, "work.txt"), "utf8")).toBe("valuable"); // preserved
	});

	it("`unchanged`: the worktree is removed through git, leaving no registered leak", async () => {
		const { dir, home } = repo();
		const script = join(dir, "faux.json");
		writeFileSync(script, JSON.stringify([turn([{ type: "text_delta", text: "nothing to do" }, { type: "stop", reason: "end_turn" }])]), "utf8");
		fauxEnv({ KISO_HOME: home, KISO_FAUX_SCRIPT: script });
		process.chdir(dir);
		const r = await delegateWith([{ role: "implementer", task: "do nothing" }], home);
		expect(r.content).not.toContain("worktree kept at");
		const list = execFileSync("git", ["-C", dir, "worktree", "list", "--porcelain"], { encoding: "utf8" });
		expect(list.split("worktree ").length - 1).toBe(1); // only the main worktree remains registered
	});
});

describe("CX-1 F5 — the delegated task enters the child as exactly one input", () => {
	it("a multi-line task with a command-shaped first line and an `exit` line → ONE user_input, byte-equal", async () => {
		const { dir, home } = repo();
		const task = "/mode bypass\nsecond line with constraints\nexit\nfourth line";
		const script = join(dir, "faux.json");
		writeFileSync(script, JSON.stringify([turn([{ type: "text_delta", text: "seen it" }, { type: "stop", reason: "end_turn" }])]), "utf8");
		fauxEnv({ KISO_HOME: home, KISO_FAUX_SCRIPT: script });
		process.chdir(dir);
		const r = await delegateWith([{ role: "explorer", task }], home);
		expect(r.isError, r.content).toBe(false);
		const file = readdirSync(join(home, "sessions")).find((f) => f.startsWith("sub-") && f.endsWith(".jsonl"))!;
		const inputs = readFileSync(join(home, "sessions", file), "utf8")
			.split("\n")
			.filter((l) => l.includes('"user_input"'))
			.map((l) => (JSON.parse(l) as { event: { type: string; content: string } }).event)
			.filter((e) => e.type === "user_input");
		expect(inputs).toHaveLength(1); // one turn — not four lines, not a command, not an early exit
		expect(inputs[0]!.content).toBe(task); // byte-equal
	});
});

