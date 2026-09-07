/**
 * DT-1a — the delegation task contract, end to end on real child kiso
 * processes (faux provider, scripted tool calls).
 *
 * scope ⇒ no shell + normalized path checks (R2.1); the tester gets a
 * worktree (R2.2); acceptance names a configured check or a parent-held
 * evaluator — never a model-supplied command — and the PARENT runs it in
 * the worktree after a completed child (R2.3); the result file carries
 * honest fields (R2.4).
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import createSubagentExtension from "../dist/kiso-subagent.mjs";

const CLI = join(fileURLToPath(new URL("../../../apps/cli", import.meta.url)), "dist", "index.js");
const ctx = { signal: new AbortController().signal };

function fauxEnv(extra: Record<string, string> = {}): void {
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.OPENAI_API_KEY;
	delete process.env.KISO_SUBAGENT_DEPTH;
	delete process.env.KISO_SUBAGENT_ARTIFACTS;
	Object.assign(process.env, { KISO_SUBAGENT_BIN: CLI, KISO_NO_UPDATE_CHECK: "1", ...extra });
}

async function delegateWith(tasks: Record<string, unknown>[], home: string): Promise<{ content: string; isError: boolean }> {
	fauxEnv({ KISO_HOME: home });
	const ext = await createSubagentExtension();
	const delegate = ext.tools!.find((t) => t.name === "delegate")!;
	return (await delegate.execute({ tasks }, ctx)) as { content: string; isError: boolean };
}

function repo(): { dir: string; home: string } {
	const dir = mkdtempSync(join(tmpdir(), "kiso-dt1a-"));
	const home = join(dir, "home");
	mkdirSync(join(home, "sessions"), { recursive: true });
	execFileSync("git", ["init", "-q", dir]);
	execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
	execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "src", "base.ts"), "export const base = 1;\n", "utf8");
	writeFileSync(join(dir, "README.md"), "hi\n", "utf8");
	execFileSync("git", ["-C", dir, "add", "."]);
	execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
	return { dir, home };
}

const turn = (events: object[]) => ({ events });
const call = (callId: string, name: string, input: object) => turn([{ type: "tool_call_end", callId, name, input }, { type: "stop", reason: "tool_use" }]);
const finish = (text: string) => turn([{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }]);

function resultFiles(home: string): Record<string, unknown>[] {
	const dir = join(home, "sessions", "subagent");
	return readdirSync(dir)
		.filter((f) => f.endsWith(".result.json"))
		.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>);
}

let cwd0: string;
beforeEach(() => {
	cwd0 = process.cwd();
});
afterEach(() => {
	process.chdir(cwd0);
	delete process.env.KISO_FAUX_SCRIPT;
	delete process.env.KISO_DELEGATION_CONFIG_JSON;
});

describe("DT-1a — scope: no shell, normalized path checks", () => {
	it("a scoped implementer: shell is denied, a write outside the globs is denied, a write inside lands; changedFiles lists only the inside file", async () => {
		const { dir, home } = repo();
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				call("s1", "shell", { command: "echo hi > README.md" }),
				call("w1", "write_file", { path: "README.md", content: "changed\n", expectedRevision: "absent" }),
				call("w2", "write_file", { path: "src/new.ts", content: "export const n = 2;\n", expectedRevision: "absent" }),
				finish("done\n\nUNRESOLVED\nnone"),
			]),
			"utf8",
		);
		fauxEnv({ KISO_HOME: home, KISO_FAUX_SCRIPT: script });
		process.chdir(dir);
		const r = await delegateWith([{ role: "implementer", task: "add src/new.ts", scope: ["src/**"] }], home);
		expect(r.isError, r.content).toBe(false);
		const [res] = resultFiles(home) as [{ status: string; changedFiles: { path: string }[]; scope: string[]; worktree: string }];
		expect(res.status).toBe("completed");
		expect(res.scope).toEqual(["src/**"]);
		expect(res.changedFiles.map((f) => f.path)).toEqual(["src/new.ts"]);
		expect(readFileSync(join(res.worktree, "README.md"), "utf8")).toBe("hi\n"); // the outside write never happened
		// the child's own log shows the two denials — the policy, not luck
		const log = readdirSync(join(home, "sessions")).find((f) => f.startsWith("sub-") && f.endsWith(".jsonl"))!;
		const denials = readFileSync(join(home, "sessions", log), "utf8").split("\n").filter((l) => l.includes("Permission denied"));
		expect(denials.length).toBeGreaterThanOrEqual(2);
		expect(r.content).toContain("scoped: no shell");
	});
});

describe("DT-1a — acceptance: named checks or a parent-held evaluator, run by the parent", () => {
	it("a configured check runs in the worktree after a completed child; exit code and passed are the parent's own", async () => {
		const { dir, home } = repo();
		const script = join(dir, "faux.json");
		writeFileSync(script, JSON.stringify([call("w", "write_file", { path: "src/ok.txt", content: "ok\n", expectedRevision: "absent" }), finish("done")]), "utf8");
		fauxEnv({ KISO_HOME: home, KISO_FAUX_SCRIPT: script, KISO_DELEGATION_CONFIG_JSON: JSON.stringify({ checks: { present: "test -f src/ok.txt", absent: "test -f src/missing.txt" }, profiles: [] }) });
		process.chdir(dir);
		const ok = await delegateWith([{ role: "implementer", task: "write ok", acceptance: { check: "present" } }], home);
		expect(ok.isError, ok.content).toBe(false);
		expect(ok.content).toContain("verification: PASSED");
		const bad = await delegateWith([{ role: "implementer", task: "write ok", acceptance: { check: "absent" } }], home);
		expect(bad.content).toContain("verification: FAILED");
		const results = resultFiles(home) as { verification: { kind: string; command: string; exitCode: number; passed: boolean; patchSha256: string } }[];
		const kinds = results.map((x) => x.verification);
		expect(kinds.some((v) => v.kind === "check" && v.passed === true && v.exitCode === 0)).toBe(true);
		expect(kinds.some((v) => v.kind === "check" && v.passed === false && v.exitCode !== 0)).toBe(true);
		expect(kinds.every((v) => typeof v.patchSha256 === "string" && v.patchSha256.length === 64)).toBe(true);
	});

	it("a model-supplied command is refused at delegation time — no child is spawned", async () => {
		const { dir, home } = repo();
		fauxEnv({ KISO_HOME: home });
		process.chdir(dir);
		const r = await delegateWith([{ role: "implementer", task: "x", acceptance: { command: "rm -rf ." } }], home);
		expect(r.isError).toBe(true);
		expect(r.content).toMatch(/refused.*configured check.*evaluator/i);
		expect(readdirSync(join(home, "sessions")).filter((f) => f.endsWith(".jsonl"))).toHaveLength(0);
	});

	it("an unknown check name is refused; an evaluator outside the worktree runs, one inside the parent's tree is refused", async () => {
		const { dir, home } = repo();
		const script = join(dir, "faux.json");
		writeFileSync(script, JSON.stringify([call("w", "write_file", { path: "src/ok.txt", content: "ok\n", expectedRevision: "absent" }), finish("done")]), "utf8");
		fauxEnv({ KISO_HOME: home, KISO_FAUX_SCRIPT: script, KISO_DELEGATION_CONFIG_JSON: JSON.stringify({ checks: {}, profiles: [] }) });
		process.chdir(dir);
		const unknown = await delegateWith([{ role: "implementer", task: "x", acceptance: { check: "nope" } }], home);
		expect(unknown.isError).toBe(true);
		expect(unknown.content).toMatch(/refused/i);
		const outside = mkdtempSync(join(tmpdir(), "kiso-dt1a-eval-"));
		const evaluator = join(outside, "evaluate.sh");
		writeFileSync(evaluator, "#!/bin/sh\ntest -f \"$1/src/ok.txt\"\n", "utf8");
		chmodSync(evaluator, 0o755);
		const ran = await delegateWith([{ role: "implementer", task: "write ok", acceptance: { evaluator } }], home);
		expect(ran.isError, ran.content).toBe(false);
		expect(ran.content).toContain("verification: PASSED");
		const inside = join(dir, "evaluate.sh");
		writeFileSync(inside, "#!/bin/sh\nexit 0\n", "utf8");
		chmodSync(inside, 0o755);
		const refused = await delegateWith([{ role: "implementer", task: "x", acceptance: { evaluator: inside } }], home);
		expect(refused.isError).toBe(true);
		expect(refused.content).toMatch(/refused/i);
	});

	it("acceptance is SKIPPED when the child did not complete", async () => {
		const { dir, home } = repo();
		const script = join(dir, "faux.json");
		writeFileSync(script, JSON.stringify([turn([{ type: "text_delta", text: "…" }, { type: "stop", reason: "max_tokens" }])]), "utf8");
		fauxEnv({ KISO_HOME: home, KISO_FAUX_SCRIPT: script, KISO_DELEGATION_CONFIG_JSON: JSON.stringify({ checks: { any: "true" }, profiles: [] }) });
		process.chdir(dir);
		const r = await delegateWith([{ role: "implementer", task: "x", acceptance: { check: "any" } }], home);
		expect(r.content).toContain("verification: SKIPPED");
		const [res] = resultFiles(home) as [{ status: string; verification: { skipped: string } }];
		expect(res.status).not.toBe("completed");
		expect(res.verification.skipped).toBe(res.status);
	});
});

describe("DT-1a — the result file's honest fields", () => {
	it("unresolved is the child's list, `none` is [], absent is reported as not reported; usage counts responses, never requests", async () => {
		const { dir, home } = repo();
		const script = join(dir, "faux.json");
		writeFileSync(script, JSON.stringify([finish("looked\n\nUNRESOLVED\n- the second file was unreadable")]), "utf8");
		fauxEnv({ KISO_HOME: home, KISO_FAUX_SCRIPT: script });
		process.chdir(dir);
		const listed = await delegateWith([{ role: "explorer", task: "look" }], home);
		expect(listed.content).toContain("unresolved:\n  - the second file was unreadable");
		writeFileSync(script, JSON.stringify([finish("looked, nothing more")]), "utf8");
		const silent = await delegateWith([{ role: "explorer", task: "look again" }], home);
		expect(silent.content).toContain("unresolved: not reported");
		const results = resultFiles(home) as { unresolved: string[] | null; usage: { completedResponses: number | null; abandonedAttempts: number | null }; identity: { childId: string; endedAt: number }; status: string }[];
		expect(results.map((x) => x.unresolved).sort()).toEqual([["the second file was unreadable"], null].sort());
		for (const x of results) {
			expect(x.usage.abandonedAttempts).toBe(0);
			expect(x.identity.childId.startsWith("sub-")).toBe(true);
			expect(x.identity.endedAt).toBeGreaterThan(0);
			expect(x.status).toBe("completed");
		}
	});

	it("the task file ends with the fixed UNRESOLVED instruction", async () => {
		const { dir, home } = repo();
		const script = join(dir, "faux.json");
		writeFileSync(script, JSON.stringify([finish("ok")]), "utf8");
		fauxEnv({ KISO_HOME: home, KISO_FAUX_SCRIPT: script });
		process.chdir(dir);
		await delegateWith([{ role: "explorer", task: "look" }], home);
		const taskFile = readdirSync(join(home, "sessions", "subagent")).find((f) => f.endsWith(".task"))!;
		const body = readFileSync(join(home, "sessions", "subagent", taskFile), "utf8");
		expect(body.startsWith("look")).toBe(true);
		expect(body).toMatch(/UNRESOLVED/);
	});
});

describe("DT-1a — the tester's worktree", () => {
	it("a tester with `after` runs in the implementer's kept worktree; a tester without one gets a fresh worktree from HEAD; the section says the child saw HEAD", async () => {
		const { dir, home } = repo();
		const script = join(dir, "faux.json");
		writeFileSync(script, JSON.stringify([call("w", "write_file", { path: "src/impl.ts", content: "x\n", expectedRevision: "absent" }), finish("done")]), "utf8");
		fauxEnv({ KISO_HOME: home, KISO_FAUX_SCRIPT: script });
		process.chdir(dir);
		const impl = await delegateWith([{ role: "implementer", task: "implement" }], home);
		expect(impl.isError, impl.content).toBe(false);
		const implRes = (resultFiles(home) as { identity: { childId: string }; worktree: string; baseRev: string }[])[0]!;
		expect(existsSync(join(implRes.worktree, "src", "impl.ts"))).toBe(true);
		writeFileSync(script, JSON.stringify([call("r", "read_file", { path: "src/impl.ts" }), finish("tested")]), "utf8");
		const tester = await delegateWith([{ role: "tester", task: "run the tests", after: implRes.identity.childId }], home);
		expect(tester.isError, tester.content).toBe(false);
		const testerRes = (resultFiles(home) as { identity: { childId: string }; worktree: string }[]).find((x) => x.identity.childId.endsWith("-tester"))!;
		expect(testerRes.worktree).toBe(implRes.worktree); // the implementer's result, not the parent's tree
		expect(tester.content).toMatch(/child saw HEAD [0-9a-f]{7}/);
		const fresh = await delegateWith([{ role: "tester", task: "smoke" }], home);
		expect(fresh.isError, fresh.content).toBe(false);
		const freshRes = (resultFiles(home) as { identity: { childId: string }; worktree: string; baseRev: string }[]).filter((x) => x.identity.childId.endsWith("-tester")).find((x) => x.worktree !== implRes.worktree)!;
		expect(freshRes.worktree).not.toBe(dir); // its own worktree, never the parent's tree
		expect(freshRes.baseRev).toBe(implRes.baseRev); // from HEAD
		expect(existsSync(freshRes.worktree)).toBe(false); // a clean tester's worktree is removed after the run
		// the child logs are the proof of WHAT each tester saw: the `after`
		// tester read the implementer's file; the fresh one, at HEAD, could not
		const readResult = (childId: string): { isError: boolean; content: string } => {
			const lines = readFileSync(join(home, "sessions", `${childId}.jsonl`), "utf8").split("\n").filter((l) => l !== "");
			const ev = lines.map((l) => (JSON.parse(l) as { event: { type: string; isError?: boolean; content?: string } }).event).find((e) => e.type === "tool_result")!;
			return { isError: ev.isError === true, content: String(ev.content ?? "") };
		};
		expect(readResult(testerRes.identity.childId)).toMatchObject({ isError: false });
		expect(readResult(testerRes.identity.childId).content).toContain("x");
		expect(readResult(freshRes.identity.childId).isError).toBe(true); // src/impl.ts does not exist at HEAD
	});

	it("an unknown `after` and an unknown model profile are refused before any child runs", async () => {
		const { dir, home } = repo();
		fauxEnv({ KISO_HOME: home, KISO_DELEGATION_CONFIG_JSON: JSON.stringify({ checks: {}, profiles: ["deepseek"] }) });
		process.chdir(dir);
		const a = await delegateWith([{ role: "tester", task: "x", after: "sub-nope" }], home);
		expect(a.isError).toBe(true);
		const m = await delegateWith([{ role: "explorer", task: "x", model: "unknown-profile" }], home);
		expect(m.isError).toBe(true);
		expect(m.content).toMatch(/refused/i);
		expect(readdirSync(join(home, "sessions")).filter((f) => f.endsWith(".jsonl"))).toHaveLength(0);
	});
});
