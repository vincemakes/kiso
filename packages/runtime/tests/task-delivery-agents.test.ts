/**
 * ADR-0058 3d — background children reach the model as a GROUP: the
 * delegate calls of one model turn. The group closes when that turn has
 * ended and every delegate call in it has its result; only a closed group
 * whose members have all ended is delivered — once, with every member's
 * line, excerpts of their answers within 4 KiB each and 16 KiB together,
 * and receipts only for what was not delivered before. A failure goes into
 * a live run at once and never wakes on its own. The TaskManager runs
 * over a fake backend; the real children are the CLI's e2e.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool, type Event, type ToolContext, type UserInputVia } from "@vincemakes/kiso-core";
import { createAgent, SessionStore, type Run } from "../src/index.js";
import { TaskDelivery } from "../src/tasks/delivery.js";
import { appendRecord } from "../src/tasks/journal.js";
import { TaskManager, type TaskBackend } from "../src/tasks/manager.js";

function fakeBackend(): TaskBackend {
	let pid = 100;
	return {
		async spawn({ dir }) {
			pid += 1;
			appendRecord(join(dir, "journal.jsonl"), { type: "runner_started", ts: Date.now(), pid, startedAt: `start-${pid}` });
			appendRecord(join(dir, "journal.jsonl"), { type: "command_started", ts: Date.now() });
		},
		identify: (p, startedAt) => (startedAt === `start-${p}` ? "verified" : "gone"),
		signalStop: () => {},
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = (id: string, name: string) => ({ type: "tool_call_end" as const, callId: id, name, input: {} });
const turn = (...calls: ReturnType<typeof call>[]) => ({ events: [...calls, { type: "stop" as const, reason: "tool_use" as const }] });
const END = { events: [{ type: "text_delta" as const, text: "ok" }, { type: "stop" as const, reason: "end_turn" as const }] };
const notices = (events: readonly Event[]) => events.filter((e): e is Event & { type: "user_input" } => e.type === "user_input" && e.via?.kind === "tasks");

/** The child's end, as the child and its runner leave it: the answer and its outcome, then the terminal. */
function endAgent(m: TaskManager, id: string, opts: { exitCode?: number; answer?: string; outcome?: string; stopped?: boolean } = {}) {
	const dir = dirname(m.get(id)!.outputPath);
	if (opts.answer !== undefined) {
		writeFileSync(join(dir, "result.md"), `${opts.answer}\n`);
		writeFileSync(join(dir, "result.json"), JSON.stringify({ outcome: opts.outcome ?? "completed", requests: 3 }));
	}
	if (opts.stopped === true) appendRecord(join(dir, "journal.jsonl"), { type: "stop_requested", ts: Date.now(), by: "model" });
	appendRecord(join(dir, "journal.jsonl"), { type: "terminal", ts: Date.now(), exitCode: opts.exitCode ?? 0, signal: null });
}

async function setup(script: FauxScript, handlers: Record<string, (ctx: ToolContext, m: TaskManager) => Promise<void>>) {
	const dir = mkdtempSync(join(tmpdir(), "kiso-agents-"));
	mkdirSync(dir, { recursive: true });
	const manager = new TaskManager({ root: join(dir, "s.tasks"), backend: fakeBackend(), pollMs: 10 });
	const tools = Object.entries(handlers).map(([name, run]) =>
		defineTool({ name, description: name, parameters: { type: "object" }, execute: async (_i, ctx) => (await run(ctx, manager), { content: `${name} done`, isError: false }) }),
	);
	const session = await createAgent({ model: "faux", store: new SessionStore(dir), tools, adapter: createFauxProvider(script) }).session({ id: "s" });
	const wakes: { content: string; via: UserInputVia }[] = [];
	session.useTasks(manager, { windowMs: 20, onWake: (w) => void wakes.push(w) });
	return { session, manager, wakes };
}

const startAgents = async (m: TaskManager, ctx: ToolContext, roles: string[]): Promise<string[]> => {
	const ids: string[] = [];
	for (const role of roles) ids.push((await m.start({ command: `${role}: look`, cwd: "/", ...(ctx.executionId !== undefined ? { executionId: ctx.executionId } : {}), agent: { role, session: `sub-${role}-${ids.length + 1}` } })).id);
	return ids;
};

async function drain(run: Run): Promise<Event[]> {
	const out: Event[] = [];
	for await (const ev of run) out.push(ev);
	return out;
}

describe("ADR-0058 3d (D2) — a group closes before it can complete", () => {
	it("a child that ends before the turn's second delegate call has started its own is held; one wake carries both", async () => {
		const { session, manager, wakes } = await setup([turn(call("a", "delegate_a"), call("b", "delegate_b")), END], {
			delegate_a: async (ctx, m) => {
				const [t1] = await startAgents(m, ctx, ["explorer"]);
				endAgent(m, t1!, { answer: "auth lives in src/auth" });
			},
			delegate_b: async (ctx, m) => {
				await sleep(150); // the delivery hears t1 end; the turn is still open
				await startAgents(m, ctx, ["reviewer"]);
			},
		});
		const events = await drain(session.run("look around"));
		expect(notices(events)).toEqual([]);
		await sleep(120);
		expect(wakes).toEqual([]); // t1 alone is not the group
		endAgent(manager, "t2", { answer: "the plan misses retries" });
		await sleep(150);
		expect(wakes).toHaveLength(1);
		expect(wakes[0]!.via).toEqual({ kind: "tasks", items: [{ taskId: "t1", transition: "exited" }, { taskId: "t2", transition: "exited" }] });
		expect(wakes[0]!.content).toMatch(/<kiso-task id="t1" kind="agent" role="explorer" status="exited" outcome="completed" session="sub-explorer-1"[^>]*result="[^"]*t1\/result\.md"\/>\nauth lives in src\/auth/);
		expect(wakes[0]!.content).toMatch(/<kiso-task id="t2" kind="agent" role="reviewer" status="exited"[^>]*\/>\nthe plan misses retries/);
		manager.close();
	});
});

describe("ADR-0058 3d (D2) — exactly once", () => {
	it("a failure goes into the live run at once; the group's wake names it as reported and receipts only the rest", async () => {
		const { session, manager, wakes } = await setup([turn(call("d", "delegate")), turn(call("w", "work")), END], {
			delegate: async (ctx, m) => void (await startAgents(m, ctx, ["explorer", "explorer", "reviewer"])),
			work: async (_ctx, m) => {
				endAgent(m, "t1", { exitCode: 1 });
				await sleep(150);
			},
		});
		const events = await drain(session.run("go"));
		expect(notices(events).map((e) => e.via)).toEqual([{ kind: "tasks", items: [{ taskId: "t1", transition: "failed" }] }]);
		await sleep(80);
		expect(wakes).toEqual([]); // a failure never wakes on its own
		endAgent(manager, "t2", { answer: "a" });
		endAgent(manager, "t3", { answer: "b" });
		await sleep(150);
		expect(wakes).toHaveLength(1);
		expect(wakes[0]!.via).toEqual({ kind: "tasks", items: [{ taskId: "t2", transition: "exited" }, { taskId: "t3", transition: "exited" }] });
		expect(wakes[0]!.content).toContain('<kiso-task id="t1" kind="agent" role="explorer" status="failed" reported="earlier"/>');
		manager.close();
	});

	it("a group that completes inside a live run is delivered there — and nothing wakes afterwards", async () => {
		const { session, manager, wakes } = await setup([turn(call("d", "delegate")), turn(call("w", "work")), END], {
			delegate: async (ctx, m) => void (await startAgents(m, ctx, ["explorer", "explorer"])),
			work: async (_ctx, m) => {
				endAgent(m, "t1", { answer: "one" });
				endAgent(m, "t2", { answer: "two", outcome: "incomplete" });
				await sleep(150);
			},
		});
		const events = await drain(session.run("go"));
		const landed = notices(events);
		expect(landed.map((e) => e.via)).toEqual([{ kind: "tasks", items: [{ taskId: "t1", transition: "exited" }, { taskId: "t2", transition: "exited" }] }]);
		expect(String(landed[0]!.content)).toMatch(/id="t2"[^>]*outcome="incomplete"/);
		await sleep(120);
		expect(wakes).toEqual([]);
		manager.close();
	});

	it("a stopped child has ended: the group completes without it running", async () => {
		const { session, manager, wakes } = await setup([turn(call("d", "delegate")), END], {
			delegate: async (ctx, m) => void (await startAgents(m, ctx, ["explorer", "explorer"])),
		});
		await drain(session.run("go"));
		endAgent(manager, "t1", { answer: "found" });
		endAgent(manager, "t2", { stopped: true, exitCode: null as unknown as number });
		await sleep(150);
		expect(wakes).toHaveLength(1);
		expect(wakes[0]!.via).toEqual({ kind: "tasks", items: [{ taskId: "t1", transition: "exited" }, { taskId: "t2", transition: "stopped" }] });
		manager.close();
	});
});

describe("ADR-0058 3d (D3) — the budget: every line, 4 KiB per child, 16 KiB per group", () => {
	it("eight long answers: every child's line is there, each excerpt is cut at 4 KiB, all of them within 16 KiB", async () => {
		const { session, manager, wakes } = await setup([turn(call("d", "delegate")), END], {
			delegate: async (ctx, m) => void (await startAgents(m, ctx, Array.from({ length: 8 }, () => "explorer"))),
		});
		await drain(session.run("go"));
		for (let i = 1; i <= 8; i++) endAgent(manager, `t${i}`, { answer: `${i}`.repeat(10_000) });
		await sleep(200);
		expect(wakes).toHaveLength(1);
		const content = wakes[0]!.content;
		for (let i = 1; i <= 8; i++) expect(content).toContain(`<kiso-task id="t${i}" kind="agent"`);
		const excerpts = content.split("\n").filter((l) => /^\d+/.test(l));
		for (const e of excerpts) expect(Buffer.byteLength(e)).toBeLessThanOrEqual(4096);
		expect(excerpts.reduce((n, e) => n + Buffer.byteLength(e), 0)).toBeLessThanOrEqual(16_384);
		expect(content).toMatch(/… \[truncated; the whole answer: [^\]]*t1\/result\.md\]/);
		expect(content).toMatch(/\[the whole answer: [^\]]*t8\/result\.md\]/);
		manager.close();
	});
});

describe("ADR-0058 3d (D2) — a group never waits for a call that cannot answer", () => {
	const log = (...events: object[]) => events.map((e, i) => ({ seq: i + 1, ...e })) as unknown as Event[];
	async function ended(events: Event[]) {
		const manager = new TaskManager({ root: join(mkdtempSync(join(tmpdir(), "kiso-agents-")), "s.tasks"), backend: fakeBackend(), pollMs: 10 });
		await manager.start({ command: "explorer: look", cwd: "/", executionId: "ex-d", agent: { role: "explorer", session: "sub-1" } });
		const wakes: unknown[] = [];
		const delivery = new TaskDelivery({ manager, events: () => events, liveRun: () => undefined, windowMs: 20, onWake: (w) => void wakes.push(w) });
		endAgent(manager, "t1", { answer: "found" }); // heard live: a restart never wakes
		await sleep(120);
		delivery.close();
		manager.close();
		return wakes;
	}

	it("a call an abandoned attempt voided is not waited for", async () => {
		const wakes = await ended(
			log(
				{ type: "user_input", content: "go" },
				{ type: "tool_call_end", callId: "x", name: "delegate", input: {} }, // voided: never runs
				{ type: "model_output_abandoned", voidFromSeq: 1, reason: "stream cut" },
				{ type: "tool_call_end", callId: "d", name: "delegate", input: {} },
				{ type: "tool_execution_started", executionId: "ex-d", callId: "d", invocationSeq: 4, name: "delegate", input: {} },
				{ type: "stop", reason: "tool_use" },
				{ type: "tool_result", callId: "d", invocationSeq: 4, content: "started", isError: false, executionId: "ex-d" },
			),
		);
		expect(wakes).toHaveLength(1);
	});

	it("a run that ended with a call unanswered closes its turn", async () => {
		const wakes = await ended(
			log(
				{ type: "user_input", content: "go" },
				{ type: "tool_call_end", callId: "d", name: "delegate", input: {} },
				{ type: "tool_execution_started", executionId: "ex-d", callId: "d", invocationSeq: 2, name: "delegate", input: {} },
				{ type: "tool_call_end", callId: "o", name: "other", input: {} },
				{ type: "stop", reason: "tool_use" },
				{ type: "tool_result", callId: "d", invocationSeq: 2, content: "started", isError: false, executionId: "ex-d" },
				{ type: "terminal", outcome: { kind: "aborted" } },
			),
		);
		expect(wakes).toHaveLength(1);
	});
});

describe("ADR-0058 3d — a restart", () => {
	it("children that ended while nobody listened are delivered as a notify on the next run — never a wake", async () => {
		const { session, manager } = await setup([turn(call("d", "delegate")), END, END], {
			delegate: async (ctx, m) => void (await startAgents(m, ctx, ["explorer", "reviewer"])),
		});
		await drain(session.run("go"));
		manager.close();
		endAgent(manager, "t1", { answer: "x" });
		endAgent(manager, "t2", { answer: "y" });
		const restarted = new TaskManager({ root: manager.root, backend: fakeBackend(), pollMs: 10 });
		const wakes: unknown[] = [];
		session.useTasks(restarted, { windowMs: 20, onWake: (w) => void wakes.push(w) });
		await sleep(100);
		expect(wakes).toEqual([]);
		const landed = notices(await drain(session.run("hi")));
		expect(landed.map((e) => e.via)).toEqual([{ kind: "tasks", items: [{ taskId: "t1", transition: "exited" }, { taskId: "t2", transition: "exited" }] }]);
		restarted.close();
	});
});

describe("0.49.0 I5 — the result record commits a child's answer", () => {
	it("an answer the child wrote without its record is not shown as its result: the notice names the output and shows the tail", async () => {
		const { session, manager, wakes } = await setup([turn(call("d", "delegate")), END], {
			delegate: async (ctx, m) => void (await startAgents(m, ctx, ["explorer"])),
		});
		await drain(session.run("go"));
		const dir = dirname(manager.get("t1")!.outputPath);
		// the child died between its two writes: result.md, never result.json
		writeFileSync(join(dir, "result.md"), "an answer nothing committed\n");
		writeFileSync(manager.get("t1")!.outputPath, "the child's last printed line\n");
		appendRecord(join(dir, "journal.jsonl"), { type: "terminal", ts: Date.now(), exitCode: 1, signal: null });
		await sleep(150);
		const all = [...notices(session.log.all as Event[]).map((e) => String(e.content)), ...wakes.map((w) => w.content)].join("\n");
		expect(all).toContain("the child's last printed line");
		expect(all).not.toContain("an answer nothing committed");
		expect(all).not.toMatch(/result="[^"]*t1\/result\.md"/);
		expect(all).toMatch(/<kiso-task id="t1"[^>]*output="[^"]*"\/>/);
		manager.close();
	});

	it("a failed child's record leads its excerpt with the error, then its tail", async () => {
		const { session, manager, wakes } = await setup([turn(call("d", "delegate")), END], {
			delegate: async (ctx, m) => void (await startAgents(m, ctx, ["explorer"])),
		});
		await drain(session.run("go"));
		const dir = dirname(manager.get("t1")!.outputPath);
		writeFileSync(join(dir, "result.md"), "");
		writeFileSync(join(dir, "result.json"), JSON.stringify({ outcome: "failed", endedBy: "error", error: "402: request failed: 402 Insufficient Balance" }));
		writeFileSync(manager.get("t1")!.outputPath, `${"x".repeat(100_000)}\nthe last line\n`);
		appendRecord(join(dir, "journal.jsonl"), { type: "terminal", ts: Date.now(), exitCode: 1, signal: null });
		await sleep(150);
		const all = [...notices(session.log.all as Event[]).map((e) => String(e.content)), ...wakes.map((w) => w.content)].join("\n");
		expect(all).toMatch(/\/>\nerror: 402: request failed: 402 Insufficient Balance\n…x+\nthe last line/);
		expect(all.length).toBeLessThan(6_000); // never the 100 KB the child printed
		manager.close();
	});
});
