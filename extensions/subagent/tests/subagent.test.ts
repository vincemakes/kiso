/**
 * ④ — subagent unit tests (against the BUILT dist/kiso-subagent.mjs, the
 * artifact the E1 loader imports). Children are real kiso processes in
 * faux mode: both API keys are removed from the test env and
 * KISO_FAUX_SCRIPT injects the child's scripted trajectory (the kill9
 * mechanism).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import createSubagentExtension, { extractChildResult, rolePolicyContent } from "../dist/kiso-subagent.mjs";

const CLI = join(fileURLToPath(new URL("../../../apps/cli", import.meta.url)), "dist", "index.js");

/** Child runs are faux: no API keys may leak into the spawned children. */
function fauxEnv(extra: Record<string, string> = {}): void {
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.OPENAI_API_KEY;
	delete process.env.KISO_SUBAGENT_DEPTH;
	Object.assign(process.env, {
		KISO_SUBAGENT_BIN: CLI,
		...(extra ?? {}),
	});
}

const ctx = { signal: new AbortController().signal };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function delegateWith(tasks: { role: string; task: string }[], home: string): Promise<{ content: string; isError: boolean }> {
	fauxEnv({ KISO_HOME: home });
	const ext = await createSubagentExtension();
	const delegate = ext.tools!.find((t) => t.name === "delegate")!;
	return (await delegate.execute({ tasks }, ctx)) as { content: string; isError: boolean };
}

describe("④ subagent: guard and role policies", () => {
	it("① the depth guard: KISO_SUBAGENT_DEPTH >= 1 → NO delegate tool", async () => {
		process.env.KISO_SUBAGENT_DEPTH = "1";
		try {
			const ext = await createSubagentExtension();
			expect(ext.name).toBe("subagent");
			expect(ext.tools).toEqual([]);
		} finally {
			delete process.env.KISO_SUBAGENT_DEPTH;
		}
	});

	it("② the role policies: explorer denies write_file/asks-never, implementer allows all six", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-subagent-pol-"));
		const load = async (role: string) => {
			const file = join(dir, `${role}.mjs`);
			writeFileSync(file, rolePolicyContent(role), "utf8");
			return (await import(pathToFileURL(file).href)).default;
		};
		const explorer = (await load("explorer")).approvals[0].decide;
		expect(explorer({ name: "read_file", input: {} })).toMatchObject({ action: "allow" });
		expect(explorer({ name: "write_file", input: {} })).toMatchObject({ action: "deny", reason: expect.stringContaining("explorer") });
		expect(explorer({ name: "shell", input: {} })).toMatchObject({ action: "deny" });
		const impl = (await load("implementer")).approvals[0].decide;
		expect(impl({ name: "write_file", input: {} })).toMatchObject({ action: "allow" });
		expect(impl({ name: "shell", input: {} })).toMatchObject({ action: "allow" });
		// Only allow/deny — a headless child must never see an ask.
		expect(rolePolicyContent("explorer")).not.toContain("ask");
		expect(rolePolicyContent("implementer")).not.toContain("ask");
		expect(rolePolicyContent("reviewer")).not.toContain("ask");
		expect(rolePolicyContent("tester")).not.toContain("ask");
	});

	it("③ the result is extracted from the child's session JSONL, never stdout", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-subagent-x-"));
		const sessions = join(dir, "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(sessions, "sub-x-1-explorer.jsonl"),
			[
				JSON.stringify({ seq: 0, type: "user_input", content: "go" }),
				JSON.stringify({ seq: 1, type: "text_delta", text: "first words" }),
				JSON.stringify({ seq: 2, type: "tool_call_end", callId: "c1", name: "read_file", input: {} }),
				JSON.stringify({ seq: 3, type: "tool_result", callId: "c1", content: "x", isError: false }),
				JSON.stringify({ seq: 4, type: "text_delta", text: "final answer" }),
				JSON.stringify({ seq: 5, type: "stop", reason: "end_turn" }),
				JSON.stringify({ seq: 6, type: "terminal", outcome: { kind: "completed" } }),
			].join("\n"),
			"utf8",
		);
		const r = await extractChildResult(sessions, "sub-x-1-explorer", "");
		expect(r.outcome).toBe("completed");
		expect(r.text).toBe("final answer"); // the final assistant text, after the tool boundary
		expect(r.toolCalls).toBe(1);
		expect(r.failed).toBe(false);
		// Missing JSONL → failed, stdout only as a diagnostic.
		const missing = await extractChildResult(sessions, "sub-zzz", "exit 7\nstdout diag");
		expect(missing.failed).toBe(true);
		expect(missing.outcome).toBe("missing");
		expect(missing.diag).toContain("exit 7");
	});
});

describe("④ subagent: real child processes", () => {
	it("④ a slow child + a short timeout → a timely isError and the child process group is dead", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-subagent-t-"));
		const home = join(dir, "home");
		mkdirSync(join(home, "sessions"), { recursive: true });
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{ events: [{ type: "tool_call_end", callId: "s1", name: "shell", input: { command: "sleep 30" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		fauxEnv({ KISO_HOME: home, KISO_FAUX_SCRIPT: script, KISO_SUBAGENT_TIMEOUT_MS: "1500" });
		const ext = await createSubagentExtension();
		const delegate = ext.tools!.find((t) => t.name === "delegate")!;
		const started = Date.now();
		const r = (await delegate.execute({ tasks: [{ role: "tester", task: "slow work" }] }, ctx)) as { content: string; isError: boolean };
		expect(r.isError).toBe(true);
		expect(String(r.content)).toContain("timed out");
		expect(Date.now() - started).toBeLessThan(10_000); // timely — never the full 30s
		// The child process group is dead.
		await sleep(500);
		const ps = execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" });
		expect(ps).not.toMatch(/chat sub-parent-1-tester/);
	}, 60_000);

	it("⑤ six tasks run at most CONCURRENCY (4) at once — the cap holds", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-subagent-c-"));
		const home = join(dir, "home");
		const sessions = join(home, "sessions");
		mkdirSync(sessions, { recursive: true });
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{ events: [{ type: "tool_call_end", callId: "s1", name: "shell", input: { command: "sleep 1" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		fauxEnv({ KISO_HOME: home, KISO_FAUX_SCRIPT: script });
		const ext = await createSubagentExtension();
		const delegate = ext.tools!.find((t) => t.name === "delegate")!;
		// Two probes. The CAP is a cap on PROCESSES (runLimited → runProcess),
		// so the cap assertion counts LIVE child processes (ps) — the metric
		// the cap actually governs. The session-log view — child sessions
		// WITHOUT a terminal — stays as the concurrency witness and as a
		// diagnostic. SA-F1 (CI 34308267020, a docs-only commit; the same
		// code green before and after): this view read a peak of 6. A child
		// that exits WITHOUT a terminal stays "in flight" in this view until
		// the parent gives up on it (extractChildResult's 2 s retry) and frees
		// the slot, so a log peak above the cap can mean "children failed on
		// this runner", not "the cap broke" — and the old assertion order
		// (peak before completion) could not tell the two apart. Completion
		// first, the process cap second, the log view last with its snapshot.
		let running = true;
		const probe = (async () => {
			let logPeak = 0;
			let psPeak = 0;
			let snapshot: string[] = [];
			let psSnapshot: string[] = [];
			while (running) {
				const files = readdirSync(sessions).filter((f) => f.startsWith("sub-parent-") && f.endsWith(".jsonl"));
				const open = files.filter((f) => !readFileSync(join(sessions, f), "utf8").includes('"terminal"'));
				if (open.length > logPeak) {
					logPeak = open.length;
					snapshot = open.map((f) => `${f} (${statSync(join(sessions, f)).size} bytes)`);
				}
				// Only OUR children: the delegate spawns from this very process, so
				// the parent pid is ours. A bare command-line match over-counts —
				// any shell whose command text mentions the pattern matches too.
				const alive = execFileSync("ps", ["-eo", "pid=,ppid=,command="], { encoding: "utf8" })
					.split("\n")
					.filter((l) => l.includes("chat sub-parent-") && Number.parseInt(l.trim().split(/\s+/)[1] ?? "", 10) === process.pid);
				if (alive.length > psPeak) {
					psPeak = alive.length;
					psSnapshot = alive.map((l) => l.trim().slice(0, 160));
				}
				await sleep(50);
			}
			return { logPeak, psPeak, snapshot, psSnapshot };
		})();
		const tasks = Array.from({ length: 6 }, (_, i) => ({ role: "tester", task: `task ${i + 1}` }));
		const r = (await delegate.execute({ tasks }, ctx)) as { content: string; isError: boolean };
		running = false;
		const { logPeak, psPeak, snapshot, psSnapshot } = await probe;
		// 1. every child completed — a failed child is a different finding than a broken cap
		expect(r.isError).toBe(false);
		expect(r.content.split("\n")[0]).toMatch(/^summary: \d+ tool calls · 1 role · 0 failed$/);
		// 2. the cap, on the metric it governs
		expect(psPeak, `live child processes at the peak:\n${psSnapshot.join("\n")}`).toBeLessThanOrEqual(4);
		expect(psPeak, "live child processes at the peak").toBeGreaterThanOrEqual(2); // genuinely concurrent
		// 3. the session-log view agrees once every child completed (a slot is held until its terminal is seen)
		expect(logPeak, `child sessions without a terminal at the peak: ${snapshot.join(", ")}`).toBeLessThanOrEqual(4);
	}, 120_000);

	it("⑥ implementer: a diff lands and its worktree is KEPT; a no-change child's worktree is DELETED", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-subagent-w-"));
		const home = join(dir, "home");
		mkdirSync(join(home, "sessions"), { recursive: true });
		// A real git repo as the parent workspace.
		execFileSync("git", ["init", "-q", dir]);
		execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
		execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
		writeFileSync(join(dir, "base.txt"), "base", "utf8");
		execFileSync("git", ["-C", dir, "add", "."]);
		execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
		// The child writes a NEW file in the worktree.
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{ events: [{ type: "tool_call_end", callId: "w1", name: "write_file", input: { path: "new.txt", content: "x", expectedRevision: "absent" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		fauxEnv({ KISO_HOME: home, KISO_FAUX_SCRIPT: script });
		process.chdir(dir); // the delegate's parent cwd IS the git repo
		const r = (await delegateWith([{ role: "implementer", task: "add a file" }], home)) as { content: string; isError: boolean };
		expect(r.isError).toBe(false);
		expect(String(r.content)).toContain("new.txt"); // the diff mentions the new file
		const kept = /worktree kept at: (.+)/.exec(String(r.content));
		expect(kept).not.toBeNull();
		expect(existsSync(kept![1]!)).toBe(true); // the worktree with the diff is RETAINED
		// A no-change child: its worktree is deleted.
		writeFileSync(
			script,
			JSON.stringify([
				{ events: [{ type: "text_delta", text: "nothing to do" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const r2 = (await delegateWith([{ role: "implementer", task: "do nothing" }], home)) as { content: string; isError: boolean };
		expect(String(r2.content)).not.toContain("worktree kept at"); // no diff → deleted
		expect(String(r2.content)).toContain("status: completed"); // DT-1a: the section's first line is status · verification
		// W12: the blob OPENS with the machine-readable summary line the
		// TUI's settled row renders (the per-section text is preserved
		// below it — the model's view is unchanged)
		expect(String(r2.content)).toMatch(/^summary: 0 tool calls · 1 role · 0 failed\n/);
	}, 120_000);

	it("P3: the child session id uses ctx.sessionId when the loop provides it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-subagent-p3-"));
		const home = join(dir, "home");
		mkdirSync(join(home, "sessions"), { recursive: true });
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([{ events: [{ type: "text_delta", text: "quick" }, { type: "stop", reason: "end_turn" }] }]),
			"utf8",
		);
		fauxEnv({ KISO_HOME: home, KISO_FAUX_SCRIPT: script });
		const ext = await createSubagentExtension();
		const delegate = ext.tools!.find((t) => t.name === "delegate")!;
		const r = (await delegate.execute(
			{ tasks: [{ role: "explorer", task: "quick" }] },
			{ signal: new AbortController().signal, sessionId: "parent-sess-42" },
		)) as { content: string; isError: boolean };
		expect(r.isError).toBe(false);
		// DECLARED SUPERSESSION (CX-1 F6): the child id carries a per-invocation
		// delegation identity between the parent id and the index —
		// sub-<parent>-<24 hex>-<i>-<role> — so two invocations never share a file.
		const file = readdirSync(join(home, "sessions")).find((f) => /^sub-parent-sess-42-[0-9a-f]{24}-1-explorer\.jsonl$/.test(f));
		expect(file).toBeDefined(); // the threaded session id names the child
	}, 60_000);

	it("⑦ a non-git parent fails implementer tasks HONESTLY — the git requirement is stated", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-subagent-ng-"));
		const home = join(dir, "home");
		mkdirSync(join(home, "sessions"), { recursive: true });
		writeFileSync(join(dir, "plain.txt"), "x", "utf8"); // NOT a git repo
		process.chdir(dir);
		const r = (await delegateWith([{ role: "implementer", task: "change things" }], home)) as { content: string; isError: boolean };
		expect(r.isError).toBe(true);
		expect(String(r.content)).toContain("git");
		expect(String(r.content)).toContain("FAILED");
	}, 60_000);
});
