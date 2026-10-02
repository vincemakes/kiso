/**
 * ADR-0058 3d — `delegate({ …, background: true })` over the host's task
 * manager (a fake here; the real runner and child are the CLI's e2e).
 *
 * D1 explorer/reviewer only; D4 the whole batch fits the cap or nothing
 * starts, correct under concurrent calls; D5 no timeoutMs; D6 the child's
 * turn budget rides its argv; the child's inputs are durable before its
 * task is started; a host without tasks sees today's schema.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import createSubagentExtension from "../dist/kiso-subagent.mjs";

type Started = { id: string; command: string; cwd: string; executionId?: string; agent: { role: string; session: string }; env: Record<string, string | undefined>; exec: { file: string; args: string[] }; inputsDurable: boolean };

function fakeTasks(live: number, gate?: Promise<void>) {
	const base = mkdtempSync(join(tmpdir(), "kiso-bg-tasks-"));
	const list: { id: string; agent?: unknown; state: { kind: string } }[] = Array.from({ length: live }, (_, i) => ({ id: `t${i + 1}`, agent: { role: "explorer", session: `s${i}` }, state: { kind: "running" } }));
	const started: Started[] = [];
	const manager = {
		list: () => list,
		start: async (o: { command: string; cwd: string; executionId?: string; agent: Started["agent"]; env: Started["env"]; exec: (dir: string) => Started["exec"] }) => {
			const id = `t${list.length + 1}`;
			list.push({ id, agent: o.agent, state: { kind: "starting" } });
			const dir = join(base, id);
			mkdirSync(dir, { recursive: true });
			const exec = o.exec(dir);
			const taskFile = exec.args[exec.args.indexOf("--task-file") + 1]!;
			const inputsDurable = existsSync(taskFile) && existsSync(join(o.env.KISO_EXTENSIONS_DIR!, "policy.mjs"));
			if (gate !== undefined) await gate;
			started.push({ id, command: o.command, cwd: o.cwd, ...(o.executionId !== undefined ? { executionId: o.executionId } : {}), agent: o.agent, env: o.env, exec, inputsDurable });
			return { id, outputPath: join(dir, "output.log") };
		},
	};
	return { manager, started, base };
}

const ctx = (sessionId = "parent-s") => ({ signal: new AbortController().signal, sessionId, executionId: "ex-1" });
const explorer = (task = "map the auth flow") => ({ role: "explorer", task });

async function delegateOf(host: Record<string, unknown> = {}) {
	const ext = await createSubagentExtension(host as never);
	return ext.tools!.find((t) => t.name === "delegate")!;
}

beforeEach(() => {
	const home = mkdtempSync(join(tmpdir(), "kiso-bg-home-"));
	delete process.env.KISO_SUBAGENT_DEPTH;
	delete process.env.KISO_SUBAGENT_ARTIFACTS;
	delete process.env.KISO_DELEGATION_CONFIG_JSON;
	Object.assign(process.env, { KISO_HOME: home, KISO_SESSIONS_DIR: join(home, "sessions"), KISO_SUBAGENT_BIN: "/path/to/kiso cli.js" });
});

describe("ADR-0058 3d — the schema", () => {
	it("a host without tasks sees today's delegate schema; wired, the only difference is `background`", async () => {
		const plain = await delegateOf();
		const wired = await delegateOf({ tasks: () => undefined });
		expect(JSON.stringify(plain.parameters)).not.toContain("background");
		const { background, ...rest } = (wired.parameters as { properties: Record<string, unknown> }).properties;
		expect(background).toMatchObject({ type: "boolean" });
		expect(JSON.stringify({ ...(wired.parameters as object), properties: rest })).toBe(JSON.stringify(plain.parameters));
		expect(wired.description).toBe(plain.description);
	});
});

describe("ADR-0058 3d — a background call", () => {
	it("returns at once with one agent task per child; argv launch with the turn budget; inputs durable first", async () => {
		const { manager, started } = fakeTasks(0);
		const delegate = await delegateOf({ tasks: () => manager });
		const r = (await delegate.execute({ tasks: [explorer(), { role: "reviewer", task: "review the plan" }], background: true }, ctx() as never)) as { content: string; isError: boolean };
		expect(r.isError).toBe(false);
		expect(r.content).toMatch(/^started 2 background children: t1 explorer \(session sub-parent-s-[0-9a-f]+-1-explorer\), t2 reviewer \(session sub-parent-s-[0-9a-f]+-2-reviewer\)\./);
		expect(r.content).toMatch(/read the workspace as it is while they run/);
		expect(r.content).toMatch(/told when all of them have ended/);
		expect(started.map((s) => s.agent.role)).toEqual(["explorer", "reviewer"]);
		const s = started[0]!;
		expect(s.executionId).toBe("ex-1");
		expect(s.command).toBe("explorer: map the auth flow");
		expect(s.cwd).toBe(process.cwd());
		expect(s.exec.file).toBe(process.execPath);
		expect(s.exec.args.slice(0, 3)).toEqual(["/path/to/kiso cli.js", "chat", s.agent.session]);
		const at = (flag: string) => s.exec.args[s.exec.args.indexOf(flag) + 1];
		expect(at("--max-turns")).toBe("32");
		expect(at("--result-file")).toMatch(/t1\/result\.md$/);
		expect(readFileSync(at("--task-file")!, "utf8")).toMatch(/^map the auth flow\n\nWhen you finish, end your reply with a section titled UNRESOLVED/);
		expect(s.inputsDurable).toBe(true);
		expect(s.env).toMatchObject({ KISO_SUBAGENT_DEPTH: "1", KISO_MODE: "bypass" });
		expect(readFileSync(join(s.env.KISO_EXTENSIONS_DIR!, "policy.mjs"), "utf8")).toContain('["read_file","list_dir","search_text"]');
	});

	it("backgroundMaxTurns is the host's", async () => {
		const { manager, started } = fakeTasks(0);
		const delegate = await delegateOf({ tasks: () => manager, backgroundMaxTurns: 5 });
		await delegate.execute({ tasks: [explorer()], background: true }, ctx() as never);
		expect(started[0]!.exec.args[started[0]!.exec.args.indexOf("--max-turns") + 1]).toBe("5");
	});

	it("D1: an implementer or tester is refused, nothing starts", async () => {
		const { manager, started } = fakeTasks(0);
		const delegate = await delegateOf({ tasks: () => manager });
		for (const role of ["implementer", "tester"]) {
			const r = (await delegate.execute({ tasks: [explorer(), { role, task: "x" }], background: true }, ctx() as never)) as { content: string; isError: boolean; errorKind?: string };
			expect(r).toMatchObject({ isError: true, errorKind: "precondition" });
			expect(r.content).toContain(`background is not supported for the ${role} role in this release; run this delegation in the foreground`);
		}
		expect(started).toEqual([]);
	});

	it("D5: background with timeoutMs is refused, nothing starts", async () => {
		const { manager, started } = fakeTasks(0);
		const delegate = await delegateOf({ tasks: () => manager });
		const r = (await delegate.execute({ tasks: [{ ...explorer(), timeoutMs: 60_000 }], background: true }, ctx() as never)) as { content: string; isError: boolean };
		expect(r.isError).toBe(true);
		expect(r.content).toMatch(/timeoutMs applies to a foreground delegation.*task_stop/);
		expect(started).toEqual([]);
	});

	it("D4: the whole batch fits or nothing starts — 19 live and 2 asked is refused; 1 is not", async () => {
		const { manager, started } = fakeTasks(19);
		const delegate = await delegateOf({ tasks: () => manager });
		const r = (await delegate.execute({ tasks: [explorer(), explorer()], background: true }, ctx() as never)) as { content: string; isError: boolean };
		expect(r.isError).toBe(true);
		expect(r.content).toMatch(/19 background children are running.*cap is 20.*asks for 2.*Do not retry/);
		expect(started).toEqual([]);
		const ok = (await delegate.execute({ tasks: [explorer()], background: true }, ctx() as never)) as { isError: boolean };
		expect(ok.isError).toBe(false);
		expect(started).toHaveLength(1);
	});

	it("D4 under concurrency: two calls raced in one tick never exceed the cap", async () => {
		let open!: () => void;
		const { manager, started } = fakeTasks(17, new Promise<void>((r) => (open = r)));
		const delegate = await delegateOf({ tasks: () => manager });
		const a = delegate.execute({ tasks: [explorer(), explorer()], background: true }, ctx() as never) as Promise<{ isError: boolean }>;
		const b = delegate.execute({ tasks: [explorer(), explorer()], background: true }, ctx() as never) as Promise<{ isError: boolean; content: string }>;
		open();
		const [ra, rb] = await Promise.all([a, b]);
		expect(ra.isError).toBe(false);
		expect(rb.isError).toBe(true);
		expect(started).toHaveLength(2);
	});

	it("a host whose session has no task manager refuses background", async () => {
		const delegate = await delegateOf({ tasks: () => undefined });
		const r = (await delegate.execute({ tasks: [explorer()], background: true }, ctx() as never)) as { content: string; isError: boolean };
		expect(r).toMatchObject({ isError: true });
		expect(r.content).toMatch(/background is not available here/);
	});
});
