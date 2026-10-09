/**
 * DT-1a — the delegation task contract, end to end on real child kiso
 * processes (faux provider, scripted tool calls).
 *
 * scope ⇒ no shell + normalized path checks (R2.1); the verifier gets a
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

describe("DT1a-F1/F2 (owner dogfood 2026-09-08): a refusal before any child is a precondition, and the schema says the rules", () => {
	it("a scoped explorer and an unknown check are refused with errorKind precondition — nothing ran, so no partial-side-effects banner can attach", async () => {
		const { home } = repo();
		fauxEnv();
		const scoped = (await delegateWith([{ role: "explorer", task: "look", scope: ["src/**"] }], home)) as { content: string; isError: boolean; errorKind?: string };
		expect(scoped.isError).toBe(true);
		expect(scoped.content).toContain("scope applies to implementer and verifier tasks only");
		expect(scoped.errorKind).toBe("precondition");
		const unknown = (await delegateWith([{ role: "implementer", task: "do", acceptance: { check: "nope" } }], home)) as { content: string; isError: boolean; errorKind?: string };
		expect(unknown.isError).toBe(true);
		expect(unknown.errorKind).toBe("precondition");
	});

	it("ADR-0032 Amendment 1: the role is verifier — tester is not in the schema, and a direct call is told it was renamed", async () => {
		const { home } = repo();
		fauxEnv();
		const ext = await createSubagentExtension();
		const delegate = ext.tools!.find((t) => t.name === "delegate")!;
		const role = (delegate.parameters as { properties: { tasks: { items: { properties: { role: { enum: string[] } } } } } }).properties.tasks.items.properties.role;
		expect(role.enum).toEqual(["explorer", "implementer", "reviewer", "verifier"]);
		expect(JSON.stringify(delegate.parameters)).not.toContain("tester");
		expect(delegate.description).toBe("run subagent tasks (explorer/implementer/reviewer/verifier) in child kiso processes");
		const old = (await delegateWith([{ role: "tester", task: "run the tests" }], home)) as { content: string; isError: boolean; errorKind?: string };
		expect(old).toMatchObject({ isError: true, errorKind: "precondition" });
		expect(old.content).toContain('unknown role "tester" — it is called "verifier" since 0.46.0');
	});

	it("the delegate schema tells the model where scope and acceptance apply, and names the configured checks", async () => {
		fauxEnv({ KISO_DELEGATION_CONFIG_JSON: JSON.stringify({ checks: { test: "npm test", lint: "npm run lint" } }) });
		const ext = await createSubagentExtension();
		const delegate = ext.tools!.find((t) => t.name === "delegate")!;
		const props = (delegate.parameters as { properties: { tasks: { items: { properties: Record<string, { description?: string }> } } } }).properties.tasks.items.properties;
		expect(props.scope!.description).toMatch(/implementer\/verifier only/);
		expect(props.acceptance!.description).toContain("test");
		expect(props.acceptance!.description).toContain("lint");
		expect(props.acceptance!.description).toMatch(/never a command/i);
		expect(props.model).toBeUndefined(); // no profile configured
		delete process.env.KISO_DELEGATION_CONFIG_JSON;
	});

	it("Plan B: a field the user has not configured is not in the schema at all", async () => {
		delete process.env.KISO_DELEGATION_CONFIG_JSON;
		const bare = (await createSubagentExtension()).tools!.find((t) => t.name === "delegate")!;
		const props = (bare.parameters as { properties: { tasks: { items: { properties: Record<string, unknown> } } } }).properties.tasks.items.properties;
		expect(Object.keys(props).sort()).toEqual(["after", "role", "scope", "task", "timeoutMs"]);
		expect(JSON.stringify(bare.parameters)).not.toMatch(/configured now|none configured|omit/);
	});

	it("Plan B: a configured profile or evaluator brings its field back, naming what is configured", async () => {
		fauxEnv({ KISO_DELEGATION_CONFIG_JSON: JSON.stringify({ profiles: ["fast"], evaluators: ["/opt/eval.sh"] }) });
		const d = (await createSubagentExtension()).tools!.find((t) => t.name === "delegate")!;
		const props = (d.parameters as { properties: { tasks: { items: { properties: Record<string, { description?: string }> } } } }).properties.tasks.items.properties;
		expect(props.model!.description).toContain("fast");
		expect(props.acceptance!.description).toMatch(/evaluator/);
		expect(props.acceptance!.description).not.toMatch(/check:/);
		delete process.env.KISO_DELEGATION_CONFIG_JSON;
	});

	it("Plan B: one config snapshot per extension instance — a later change does not move a live session's schema", async () => {
		fauxEnv({ KISO_DELEGATION_CONFIG_JSON: JSON.stringify({ checks: { test: "npm test" } }) });
		const ext = await createSubagentExtension();
		process.env.KISO_DELEGATION_CONFIG_JSON = JSON.stringify({ checks: { other: "make other" } });
		const d = ext.tools!.find((t) => t.name === "delegate")!;
		const desc = (d.parameters as { properties: { tasks: { items: { properties: Record<string, { description?: string }> } } } }).properties.tasks.items.properties.acceptance!.description!;
		expect(desc).toContain("test");
		expect(desc).not.toContain("other");
		delete process.env.KISO_DELEGATION_CONFIG_JSON;
	});

	it("Plan B A10 (measured): background's description stays verbatim — a shorter one was put inside tasks[] in 4 of 5 smoke legs", async () => {
		const d = (await createSubagentExtension({ tasks: () => undefined })).tools!.find((t) => t.name === "delegate")!;
		const p = d.parameters as { properties: { background?: { description?: string }; tasks: { items: { properties: Record<string, unknown> } } } };
		expect(p.properties.background!.description).toBe(
			"explorer and reviewer only: start the tasks in the background and return at once; you are told when all of them have ended. They read the workspace as it is while they run; task_stop stops one",
		);
		expect(p.properties.tasks.items.properties).not.toHaveProperty("background");
	});
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
		// DECLARED RE-PIN (CS-1, 0.40.7): an evaluator runs only when the USER
		// listed it — this case used to pass any existing path outside the
		// project. The script is listed here; the unlisted case is pinned in
		// cs1-evaluator-allowlist.test.ts.
		process.env.KISO_DELEGATION_CONFIG_JSON = JSON.stringify({ checks: {}, evaluators: [evaluator], profiles: [] });
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
		// 0.49.0 C3: UNRESOLVED reaches the model ONCE — in the answer the
		// child wrote; the parsed list is the result file's, not a repeat
		expect(listed.content).toContain("looked\n\nUNRESOLVED\n- the second file was unreadable");
		expect(listed.content.match(/the second file was unreadable/g)).toHaveLength(1);
		expect(listed.content).not.toContain("unresolved:");
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

describe("DT-1a — the verifier's worktree", () => {
	it("a verifier with `after` runs in a COPY of the implementer's kept worktree (ADR-0032 Amendment 1) — it sees the implementer's change, its own writes never reach the kept worktree, and the copy is removed; a verifier without `after` gets a fresh worktree from HEAD", async () => {
		const { dir, home } = repo();
		const script = join(dir, "faux.json");
		writeFileSync(script, JSON.stringify([call("w", "write_file", { path: "src/impl.ts", content: "x\n", expectedRevision: "absent" }), finish("done")]), "utf8");
		fauxEnv({ KISO_HOME: home, KISO_FAUX_SCRIPT: script });
		process.chdir(dir);
		const impl = await delegateWith([{ role: "implementer", task: "implement" }], home);
		expect(impl.isError, impl.content).toBe(false);
		const implRes = (resultFiles(home) as { identity: { childId: string }; worktree: string; baseRev: string }[])[0]!;
		expect(existsSync(join(implRes.worktree, "src", "impl.ts"))).toBe(true);
		writeFileSync(script, JSON.stringify([call("r", "read_file", { path: "src/impl.ts" }), call("s", "write_file", { path: "src/scratch.ts", content: "probe\n", expectedRevision: "absent" }), finish("tested")]), "utf8");
		const verifier = await delegateWith([{ role: "verifier", task: "run the tests", after: implRes.identity.childId }], home);
		expect(verifier.isError, verifier.content).toBe(false);
		type Res = { identity: { childId: string }; worktree: string; baseRev: string; after?: string };
		const verifiers = (resultFiles(home) as Res[]).filter((x) => x.identity.childId.endsWith("-verifier"));
		const afterRes = verifiers.find((x) => x.after === implRes.identity.childId)!;
		expect(afterRes.worktree).not.toBe(implRes.worktree); // a copy, never the kept worktree itself
		expect(afterRes.baseRev).toBe(implRes.baseRev);
		expect(existsSync(afterRes.worktree)).toBe(false); // the copy is removed after the run
		expect(existsSync(join(implRes.worktree, "src", "scratch.ts"))).toBe(false); // the kept worktree is untouched
		expect(readFileSync(join(implRes.worktree, "src", "impl.ts"), "utf8")).toBe("x\n");
		expect(verifier.content).toMatch(/child saw HEAD [0-9a-f]{7}/);
		writeFileSync(script, JSON.stringify([call("r", "read_file", { path: "src/impl.ts" }), finish("tested")]), "utf8");
		const fresh = await delegateWith([{ role: "verifier", task: "smoke" }], home);
		expect(fresh.isError, fresh.content).toBe(false);
		const freshRes = (resultFiles(home) as Res[]).find((x) => x.identity.childId.endsWith("-verifier") && x.after === undefined)!;
		expect(freshRes.worktree).not.toBe(dir); // its own worktree, never the parent's tree
		expect(freshRes.baseRev).toBe(implRes.baseRev); // from HEAD
		expect(existsSync(freshRes.worktree)).toBe(false); // a clean verifier's worktree is removed after the run
		// the child logs are the proof of WHAT each verifier saw: the `after`
		// verifier read the implementer's file; the fresh one, at HEAD, could not
		const readResult = (childId: string): { isError: boolean; content: string } => {
			const lines = readFileSync(join(home, "sessions", `${childId}.jsonl`), "utf8").split("\n").filter((l) => l !== "");
			const ev = lines.map((l) => (JSON.parse(l) as { event: { type: string; isError?: boolean; content?: string } }).event).find((e) => e.type === "tool_result")!;
			return { isError: ev.isError === true, content: String(ev.content ?? "") };
		};
		expect(readResult(afterRes.identity.childId)).toMatchObject({ isError: false });
		expect(readResult(afterRes.identity.childId).content).toContain("x");
		expect(readResult(freshRes.identity.childId).isError).toBe(true); // src/impl.ts does not exist at HEAD
	});

	it("an unknown `after` and an unknown model profile are refused before any child runs", async () => {
		const { dir, home } = repo();
		fauxEnv({ KISO_HOME: home, KISO_DELEGATION_CONFIG_JSON: JSON.stringify({ checks: {}, profiles: ["deepseek"] }) });
		process.chdir(dir);
		const a = await delegateWith([{ role: "verifier", task: "x", after: "sub-nope" }], home);
		expect(a.isError).toBe(true);
		const m = await delegateWith([{ role: "explorer", task: "x", model: "unknown-profile" }], home);
		expect(m.isError).toBe(true);
		expect(m.content).toMatch(/refused/i);
		expect(readdirSync(join(home, "sessions")).filter((f) => f.endsWith(".jsonl"))).toHaveLength(0);
	});
});
