/**
 * 0.49.0 A — the join, through the subagent extension's real delegate
 * tool, a real TaskManager over the process runner, and scripted children
 * (KISO_SUBAGENT_BIN).
 *
 * A reader delegation is a group of agent tasks from its start; the call
 * waits for them up to its join budget (the shell's foreground wait,
 * reused). What ended while it waited is claimed by the call and handed
 * off in its result; what is still running continues as the group. The
 * budget, the person's key (a detach) and Esc end the WAIT, never a child.
 * A call with a writer keeps the foreground path until part B.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import createSubagent from "@vincemakes/kiso-subagent-ext";
import { TaskManager } from "@vincemakes/kiso-runtime/internal";
import { processTaskBackend } from "@vincemakes/kiso-tools-node";

const RUNNER = fileURLToPath(new URL("../../../packages/tools-node/dist/task-runner.js", import.meta.url));

/** The scripted child: sleeps CHILD_SLEEP_MS (CHILD_SLEEP_<role> wins),
 *  then writes its answer and the record that commits it. */
const CHILD = `
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const at = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const role = /-(explorer|reviewer|implementer|verifier)$/.exec(args[args.indexOf("chat") + 1])?.[1] ?? "x";
const ms = Number(process.env["CHILD_SLEEP_" + role] ?? process.env.CHILD_SLEEP_MS ?? "0");
setTimeout(() => {
	const result = at("--result-file");
	writeFileSync(result, "the " + role + " found it\\n\\nUNRESOLVED\\nnone\\n");
	writeFileSync(join(dirname(result), "result.json"), JSON.stringify({ outcome: "completed", endedBy: "completed", requests: 2, toolCalls: 1, model: "m", profile: null }));
}, ms);
`;

const saved = { ...process.env };
const savedCwd = process.cwd();
let dir: string;
let manager: TaskManager;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kiso-join-"));
	const home = join(dir, "home");
	mkdirSync(join(home, "sessions"), { recursive: true });
	writeFileSync(join(dir, "child.mjs"), CHILD, "utf8");
	for (const k of ["KISO_SUBAGENT_DEPTH", "KISO_DELEGATION_CONFIG_JSON", "CHILD_SLEEP_MS", "CHILD_SLEEP_explorer", "CHILD_SLEEP_reviewer"]) delete process.env[k];
	Object.assign(process.env, { KISO_HOME: home, KISO_SESSIONS_DIR: join(home, "sessions"), KISO_SUBAGENT_BIN: join(dir, "child.mjs") });
	process.chdir(dir);
	manager = new TaskManager({ root: join(home, "sessions", "s1.tasks"), backend: processTaskBackend({ runnerPath: RUNNER }), pollMs: 50 });
});

afterEach(async () => {
	await manager.stopAll();
	manager.close();
	process.chdir(savedCwd);
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
});

async function delegate(input: Record<string, unknown>, opts: { joinMs?: number; signal?: AbortSignal; host?: Record<string, unknown> } = {}): Promise<{ content: string; isError: boolean }> {
	const ext = await createSubagent({ tasks: (sid: string | undefined) => (sid === "s1" ? manager : undefined), ...(opts.joinMs !== undefined ? { joinMs: opts.joinMs } : {}), ...(opts.host ?? {}) } as never);
	const tool = ext.tools!.find((t) => t.name === "delegate")!;
	const ctx = { signal: opts.signal ?? new AbortController().signal, sessionId: "s1", executionId: "ex-join" };
	return (await tool.execute(input, ctx as never)) as { content: string; isError: boolean };
}

const readers = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "explorer" : "reviewer", task: `look ${i + 1}` }));

describe("0.49.0 A — a reader delegation joins its group", () => {
	it("two children done within the budget: both handoffs in one result, nothing left running, both claimed by the call", async () => {
		const r = await delegate({ tasks: readers(2) }, { joinMs: 20_000 });
		expect(r.isError).toBe(false);
		expect(r.content).toMatch(/^summary: 2 tasks · 2 tool calls · 2 roles · 0 failed/);
		expect(r.content).toMatch(/\[subagent\] explorer: look 1\n {2}status: completed · model: m \(default\) · verification: none · tools: 1 · task t1\nthe explorer found it/);
		expect(r.content).toMatch(/\[subagent\] reviewer: look 2\n[^\n]*task t2\nthe reviewer found it/);
		expect(r.content).not.toMatch(/still running|continued as background/);
		for (const id of ["t1", "t2"]) expect(manager.get(id)!.claims).toEqual([{ transition: "exited", executionId: "ex-join" }]);
	}, 30_000);

	it("one fast, one slow: the fast one's handoff, then the slow one continues as the group — never killed", async () => {
		process.env.CHILD_SLEEP_reviewer = "4000";
		const t0 = Date.now();
		const r = await delegate({ tasks: readers(2) }, { joinMs: 1_500 });
		expect(Date.now() - t0).toBeLessThan(3_500);
		expect(r.content).toContain("the explorer found it");
		expect(r.content).toMatch(/\nstill running after 1500 ms: continued as background task t2; you will be told when all of them have ended; task_stop stops one\.$/);
		expect(manager.get("t1")!.claims).toHaveLength(1);
		expect(manager.get("t2")!.claims).toBeUndefined();
		expect(manager.get("t2")!.state.kind).toBe("running");
		await manager.awaitSettled("t2", "end", 10_000);
		expect(manager.get("t2")!.state).toMatchObject({ kind: "ended", exitCode: 0 });
	}, 30_000);

	it("race 3: the person's key ends the wait at once — the children keep running, the call says who moved them", async () => {
		process.env.CHILD_SLEEP_MS = "8000";
		const t0 = Date.now();
		const pending = delegate({ tasks: readers(2) }, { joinMs: 30_000 });
		await new Promise((r) => setTimeout(r, 800));
		expect(manager.detachable().map((d) => d.executionId)).toEqual(["ex-join"]);
		expect(manager.detach("ex-join", "person")).toBe(true);
		expect(manager.detach("ex-join", "person"), "one promotion, one return").toBe(false);
		const r = await pending;
		expect(Date.now() - t0).toBeLessThan(4_000);
		expect(r.content).toMatch(/\nmoved to the background by the person: continued as background tasks t1, t2; /);
		expect(manager.list().filter((t) => t.state.kind === "running")).toHaveLength(2);
		expect(manager.detachable()).toEqual([]);
	}, 30_000);

	it("Esc ends the wait as interrupted; the children keep running", async () => {
		process.env.CHILD_SLEEP_MS = "8000";
		const esc = new AbortController();
		const pending = delegate({ tasks: readers(1) }, { joinMs: 30_000, signal: esc.signal });
		await new Promise((r) => setTimeout(r, 800));
		esc.abort();
		const r = await pending;
		expect(r.content).toMatch(/\ninterrupted: continued as background task t1; /);
		expect(manager.get("t1")!.state.kind).toBe("running");
	}, 30_000);

	it("background: true returns at once, as before — no wait, no claim", async () => {
		process.env.CHILD_SLEEP_MS = "3000";
		const r = await delegate({ tasks: readers(2), background: true }, { joinMs: 30_000 });
		expect(r.content).toMatch(/^started 2 background children: t1 explorer/);
		expect(manager.get("t1")!.claims).toBeUndefined();
	}, 30_000);

	it("a call with a writer keeps the foreground path until part B: no tasks are started", async () => {
		execFileSync("git", ["init", "-q"], { cwd: dir });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: dir });
		const r = await delegate({ tasks: [{ role: "explorer", task: "look" }, { role: "verifier", task: "check" }] }, { joinMs: 30_000 });
		expect(manager.list()).toEqual([]);
		expect(r.content).toMatch(/\[subagent\] explorer: look\n {2}status: completed · model: \S+ \(default\) · verification: none · tools: 1\n/);
	}, 30_000);
});

describe("0.49.0 I2 — only a claim made durable counts as delivered by the call", () => {
	it("an end the call could not claim is left to the group's notice, and the call says so", async () => {
		const fake = {
			list: () => [],
			start: async () => ({ id: "t1" }),
			awaitSettled: async () => ({ info: { outputPath: join(dir, "nope", "output.log"), state: { kind: "ended", exitCode: 0 } }, settled: true, claimed: false }),
		};
		const ext = await createSubagent({ tasks: () => fake, joinMs: 1_000 } as never);
		const tool = ext.tools!.find((t) => t.name === "delegate")!;
		const r = (await tool.execute({ tasks: readers(1) }, { signal: new AbortController().signal, sessionId: "s1", executionId: "ex-x" } as never)) as { content: string; isError: boolean };
		expect(r.content).toContain("[subagent] explorer: look 1\n  ended as task t1 — its result follows in the group's notice");
		expect(r.content).not.toContain("found it");
		expect(r.isError).toBe(false);
	});
});
