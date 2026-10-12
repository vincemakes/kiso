/**
 * Result Inspect, lazily — the owner's rent ruling (option 2).
 *
 * `inspect_result` is not in a fresh session's tool table. It joins once
 * the session's model-visible history names a ref — a delegate handoff's
 * pointer, a background task's start result or notice, or a ref already
 * there on resume — and it joins BEFORE the next request, the very one
 * that can see the pointer. It then stays, and the table changes once:
 * one cache break. The agent here is the real runtime over a faux
 * provider whose every request is captured; the source is wired as the
 * CLI wires it (the last extension, bound to the session it opens).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type StreamOptions, type UserInputVia } from "@vincemakes/kiso-core";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore, type Run } from "@vincemakes/kiso-runtime";
import { lazyInspectResult, RESULT_REF_PATTERN } from "../src/inspect-result.js";

const POINTER = "Detailed result: result:subagent:sub-s1-0123456789abcdef01234567-1-explorer (and /work for its tool calls). Use inspect_result only if more detail is actually needed.";
const SHELL_START = "started background task t1. Output: /x/s1.tasks/t1/output.log (read it with read_file, or query it with inspect_result ref result:task:t1). You will be notified when it ends; task_stop stops it.";
const NOTICE = '<kiso-task id="t1" status="exited" code="0" output="/x/s1.tasks/t1/output.log" inspect="result:task:t1"/>\nRuntime notice — not the user.';

const call = (id: string, name: string) => ({ type: "tool_call_end" as const, callId: id, name, input: {} });
const turn = (...calls: ReturnType<typeof call>[]) => ({ events: [...calls, { type: "stop" as const, reason: "tool_use" as const }] });
const END = { events: [{ type: "text_delta" as const, text: "ok" }, { type: "stop" as const, reason: "end_turn" as const }] };

async function drain(run: Run): Promise<void> {
	for await (const _ of run) {
		// drained
	}
}

const names = (o: StreamOptions) => (o.tools ?? []).map((t) => t.name);

async function setup(script: FauxScript, dir = mkdtempSync(join(tmpdir(), "kiso-lazy-"))) {
	const faux = createFauxProvider(script);
	const requests: StreamOptions[] = [];
	const adapter = { stream: (o: StreamOptions) => (requests.push(o), faux.stream(o)) };
	const source = lazyInspectResult({ tasks: (sid) => (sid === undefined ? undefined : { root: join(dir, `${sid}.tasks`) }) });
	const tool = (name: string, content: string) => defineTool({ name, description: name, parameters: { type: "object" }, promptSnippet: `${name} — a test tool`, execute: async () => ({ content, isError: false }) });
	const agent = createAgent({
		model: "faux",
		store: new SessionStore(dir),
		tools: [tool("plain", "nothing to inspect here"), tool("delegate", `[subagent] explorer: look\nthe answer\n${POINTER}`), tool("bg_shell", SHELL_START)],
		adapter,
		extensions: [{ name: "result-inspect", get tools() { return source.tools; } }],
	});
	const open = async (id: string) => {
		const session = await agent.session({ id });
		source.bind(session); // what the CLI's bindRestoredSession does
		return session;
	};
	return { open, requests, source, dir, agent };
}

describe("Result Inspect, lazily — the tool joins only once something is inspectable", () => {
	it("a fresh session's table lacks it; a session that never delegates never has it", async () => {
		const { open, requests } = await setup([turn(call("a", "plain")), END, END]);
		const s = await open("s1");
		await drain(s.run("go"));
		await drain(s.run("again"));
		expect(requests).toHaveLength(3);
		for (const r of requests) expect(names(r)).not.toContain("inspect_result");
	});

	it("a delegate result carrying the pointer: the VERY NEXT request has it, at the end of the table, and it stays — one change", async () => {
		const { open, requests, source } = await setup([turn(call("a", "delegate")), END, turn(call("b", "plain")), END]);
		const s = await open("s1");
		await drain(s.run("go"));
		await drain(s.run("again"));
		expect(requests).toHaveLength(4);
		expect(names(requests[0]!)).toEqual(["plain", "delegate", "bg_shell"]);
		// the request right after the result — inside the same run
		expect(names(requests[1]!)).toEqual(["plain", "delegate", "bg_shell", "inspect_result"]);
		// stable afterwards: the table changed exactly once
		for (const r of requests.slice(2)) expect(JSON.stringify(r.tools)).toBe(JSON.stringify(requests[1]!.tools));
		// the system prompt never moves: the tool carries no snippet for the table
		for (const r of requests) expect(r.systemPrompt).toBe(requests[0]!.systemPrompt);
		expect(source.armed("s1")).toBe(true);
		// the bytes the registration adds to the request's tools array: the
		// spec and its separating comma
		const spec = requests[1]!.tools!.at(-1)!;
		const added = Buffer.byteLength(JSON.stringify(requests[1]!.tools)) - Buffer.byteLength(JSON.stringify(requests[0]!.tools));
		expect(added).toBe(Buffer.byteLength(JSON.stringify(spec)) + 1);
		expect(Buffer.byteLength(JSON.stringify(spec))).toBe(720);
		expect(JSON.stringify(spec).length).toBe(718);
	});

	it("a background task's start result naming result:task:<id> arms it for the next request", async () => {
		const { open, requests } = await setup([turn(call("a", "bg_shell")), END]);
		const s = await open("s1");
		await drain(s.run("go"));
		expect(names(requests[0]!)).not.toContain("inspect_result");
		expect(names(requests[1]!)).toContain("inspect_result");
	});

	it("a task notice naming result:task:<id> — a wake run's first input — arms it for that run's first request", async () => {
		const { open, requests } = await setup([END]);
		const s = await open("s1");
		const via: UserInputVia = { kind: "tasks", items: [{ taskId: "t1", transition: "exited" }] };
		await drain(s.run(NOTICE, { source: "system", via }));
		expect(names(requests[0]!)).toContain("inspect_result");
	});

	it("resume: a ref already in the history arms it before the first request; another session on the same agent is not armed", async () => {
		const first = await setup([turn(call("a", "delegate")), END]);
		const s = await first.open("s1");
		await drain(s.run("go"));
		first.agent.close();
		// a new process: a new agent, a new source, over the same store
		const again = await setup([END, END], first.dir);
		const resumed = await again.open("s1");
		await drain(resumed.run("continue"));
		expect(names(again.requests[0]!)).toContain("inspect_result");
		// the same agent opens a session that never produced a ref
		const other = await again.open("s2");
		await drain(other.run("hello"));
		expect(names(again.requests[1]!)).not.toContain("inspect_result");
		// and switching back finds the first one still armed
		again.source.bind(resumed);
		expect(again.source.tools.map((t) => t.name)).toEqual(["inspect_result"]);
		again.agent.close();
	});

	it("the ref pattern: the pointer, the shell note and the notice match; ordinary text does not", () => {
		for (const t of [POINTER, SHELL_START, NOTICE]) expect(RESULT_REF_PATTERN.test(t), t).toBe(true);
		for (const t of ["result: task t1", "the result:task was fine", "inspect_result", "result:subagent:other-1"]) expect(RESULT_REF_PATTERN.test(t), t).toBe(false);
	});
});
