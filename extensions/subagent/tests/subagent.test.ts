/**
 * ④ — subagent unit tests (against the BUILT dist/kiso-subagent.mjs, the
 * artifact the E1 loader imports). Children are real kiso processes in
 * faux mode: both API keys are removed from the test env and
 * KISO_FAUX_SCRIPT injects the child's scripted trajectory (the kill9
 * mechanism).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
		// The probe: count child sessions WITHOUT a terminal — in-flight
		// children — and track the peak while the delegate runs.
		let running = true;
		const probe = (async () => {
			let peak = 0;
			while (running) {
				let inflight = 0;
				for (const f of readdirSync(sessions).filter((f) => f.startsWith("sub-parent-") && f.endsWith(".jsonl"))) {
					if (!readFileSync(join(sessions, f), "utf8").includes('"terminal"')) inflight += 1;
				}
				peak = Math.max(peak, inflight);
				await sleep(50);
			}
			return peak;
		})();
		const tasks = Array.from({ length: 6 }, (_, i) => ({ role: "tester", task: `task ${i + 1}` }));
		const r = (await delegate.execute({ tasks }, ctx)) as { content: string; isError: boolean };
		running = false;
		const peak = await probe;
		expect(peak).toBeGreaterThanOrEqual(2); // genuinely concurrent
		expect(peak).toBeLessThanOrEqual(4); // the cap held
		expect(r.isError).toBe(false); // all six completed
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
				{ events: [{ type: "tool_call_end", callId: "w1", name: "write_file", input: { path: "new.txt", content: "x" } }, { type: "stop", reason: "tool_use" }] },
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
		expect(String(r2.content)).toContain("outcome: completed");
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
		const file = readdirSync(join(home, "sessions")).find((f) => f.startsWith("sub-parent-sess-42-1-explorer.jsonl"));
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
