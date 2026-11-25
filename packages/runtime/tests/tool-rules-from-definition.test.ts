/**
 * R1 (2026-09-23) — the tool table's vocabulary rows are the DEFINITION's.
 *
 * The runtime carried the coding agent's routing rows as a constant keyed
 * by tool name, so a host that named a tool read_file received "never
 * shell cat/head/tail" — with or without a shell. The sentence this file
 * exists for: a definition that passes no rows gets no vocabulary line.
 * The first test is RED on the code before R1.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, END_TURN, ToolRegistry, type Event } from "@vincemakes/kiso-core";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { composeToolTable } from "../src/compose.js";
import { createAgent, SessionStore } from "../src/index.js";

const reader = defineTool({
	name: "read_file",
	description: "A host's own reader that happens to share the coding tool's name.",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	execute: async () => ({ content: "", isError: false }),
});

const ROW = { tool: "read_file", line: "read files with read_file, never shell cat/head/tail" } as const;

describe("R1: the table's vocabulary rows come from the definition", () => {
	it("no rows → a read_file tool gets no 'never shell' line (red before R1)", () => {
		const registry = new ToolRegistry();
		registry.register(reader);
		const table = composeToolTable(registry);
		expect(table).not.toMatch(/never shell/);
		expect(table).toContain("Tool use:"); // the fixed directives still compose
	});

	it("rows passed → the line is there, filtered to the ACTIVE set", () => {
		const registry = new ToolRegistry();
		registry.register(reader);
		const table = composeToolTable(registry, [ROW, { tool: "shell", line: "shell for everything else" }]);
		expect(table).toContain("- read files with read_file, never shell cat/head/tail");
		expect(table).not.toContain("shell for everything else"); // no shell tool → no shell row
	});

	it("end to end: the system prompt the adapter receives carries the definition's rows and nothing else", async () => {
		const seen: (string | undefined)[] = [];
		const capture = (script: Parameters<typeof createFauxProvider>[0]) => {
			const base = createFauxProvider(script);
			return {
				stream: (options: Parameters<typeof base.stream>[0]) => {
					seen.push(options.systemPrompt);
					return base.stream(options);
				},
			};
		};
		const script = [{ events: [{ type: "text_delta" as const, text: "ok" }, { type: "stop" as const, reason: "end_turn" as const }] }];
		const run = async (toolRules?: readonly { readonly tool: string; readonly line: string }[]) => {
			const agent = createAgent({
				model: "faux",
				systemPrompt: "You are a host.",
				store: new SessionStore(mkdtempSync(join(tmpdir(), "kiso-toolrules-"))),
				tools: [reader],
				adapter: capture(script),
				...(toolRules !== undefined ? { toolRules } : {}),
			});
			const session = await agent.session({ id: "s" });
			for await (const _ of session.run("hi")) {
				// drain
			}
		};
		await run();
		await run([ROW]);
		expect(seen).toHaveLength(2);
		expect(seen[0]).not.toMatch(/never shell/);
		expect(seen[1]).toContain("- read files with read_file, never shell cat/head/tail");
	});
});

describe("0.42.0 end to end: the per-run append reaches the adapter, the table switch withholds the block", () => {
	it("two runs see two evaluations; with toolTable off the system prompt is the base plus the appends only", async () => {
		const seen: (string | undefined)[] = [];
		let turn = 0;
		const script = [{ events: [{ type: "text_delta" as const, text: "ok" }, { type: "stop" as const, reason: "end_turn" as const }] }];
		const agent = createAgent({
			model: "faux",
			systemPrompt: "You are a host.",
			store: new SessionStore(mkdtempSync(join(tmpdir(), "kiso-append-"))),
			tools: [reader],
			toolTable: "off",
			extensions: [{ name: "plan", systemPrompt: { append: () => `Plan ${turn}.` } }],
			adapter: (() => {
				const base = createFauxProvider([...script, ...script]);
				return { stream: (options: Parameters<typeof base.stream>[0]) => { seen.push(options.systemPrompt); return base.stream(options); } };
			})(),
		});
		const session = await agent.session({ id: "s" });
		for await (const _ of session.run("one")) void _;
		turn = 1;
		for await (const _ of session.run("two")) void _;
		expect(seen).toEqual(["You are a host.\n\nPlan 0.", "You are a host.\n\nPlan 1."]);
	});
});

describe("0.42.0: the append is evaluated before EACH model request, not once per run", () => {
	it("a tool changes state mid-run; the next request's system prompt reflects it", async () => {
		const seen: (string | undefined)[] = [];
		let gate = "closed";
		const base = createFauxProvider([
			{ events: [{ type: "tool_call_end" as const, callId: "c1", name: "open_gate", input: {} }, { type: "stop" as const, reason: "tool_use" as const }] },
			{ events: [{ type: "text_delta" as const, text: "done" }, { type: "stop" as const, reason: "end_turn" as const }] },
		]);
		const openGate = defineTool({ name: "open_gate", description: "opens", parameters: { type: "object" }, execute: async () => { gate = "open"; return { content: "opened", isError: false }; } });
		const agent = createAgent({
			model: "faux",
			systemPrompt: "Base.",
			toolTable: "off",
			store: new SessionStore(mkdtempSync(join(tmpdir(), "kiso-perreq-"))),
			tools: [openGate],
			extensions: [{ name: "stage", systemPrompt: { append: () => `Gate is ${gate}.` } }],
			adapter: { stream: (o: Parameters<typeof base.stream>[0]) => { seen.push(o.systemPrompt); return base.stream(o); } },
		});
		const session = await agent.session({ id: "s" });
		for await (const _ of session.run("go")) void _;
		expect(seen).toEqual(["Base.\n\nGate is closed.", "Base.\n\nGate is open."]);
	});
});

describe("0.42.0: a tool result may end the turn (END_TURN)", () => {
	it("after the batch settles the run completes without asking the model again; the next run continues the conversation", async () => {
		let calls = 0;
		const script = [
			{ events: [{ type: "tool_call_end" as const, callId: "c1", name: "ask", input: { q: "which?" } }, { type: "stop" as const, reason: "tool_use" as const }] },
			{ events: [{ type: "text_delta" as const, text: "second turn" }, { type: "stop" as const, reason: "end_turn" as const }] },
		];
		const base = createFauxProvider(script);
		const ask = defineTool({
			name: "ask",
			description: "asks the person; the turn ends until they answer",
			parameters: { type: "object", properties: { q: { type: "string" } } },
			execute: async () => ({ content: "asked", isError: false, tags: [END_TURN] }),
		});
		const agent = createAgent({
			model: "faux",
			store: new SessionStore(mkdtempSync(join(tmpdir(), "kiso-endturn-"))),
			tools: [ask],
			adapter: { stream: (o: Parameters<typeof base.stream>[0]) => { calls += 1; return base.stream(o); } },
		});
		const session = await agent.session({ id: "s" });
		const first: string[] = [];
		for await (const ev of session.run("go")) first.push(ev.type === "terminal" ? `terminal:${ev.outcome.kind}` : ev.type);
		expect(calls).toBe(1); // the model was NOT asked again after the tagged result
		expect(first).toContain("tool_result");
		expect(first.at(-1)).toBe("terminal:completed");
		const second: string[] = [];
		for await (const ev of session.run("the answer")) second.push(ev.type === "terminal" ? `terminal:${ev.outcome.kind}` : ev.type);
		expect(calls).toBe(2); // the second run asked once and got the second script entry
		expect(second.at(-1)).toBe("terminal:completed");
		expect(second).toContain("text_delta");
	});
});

describe("0.42.0: ToolContext carries the invocation's ids", () => {
	it("ctx.callId is the tool_result's callId and ctx.executionId the tool_execution_started's, per call", async () => {
		const seen: { callId: string | undefined; executionId: string | undefined }[] = [];
		const base = createFauxProvider([
			{ events: [{ type: "tool_call_end" as const, callId: "c-A", name: "peek", input: {} }, { type: "tool_call_end" as const, callId: "c-B", name: "peek", input: {} }, { type: "stop" as const, reason: "tool_use" as const }] },
			{ events: [{ type: "text_delta" as const, text: "done" }, { type: "stop" as const, reason: "end_turn" as const }] },
		]);
		const peek = defineTool({
			name: "peek",
			description: "records the ids it was handed",
			parameters: { type: "object" },
			execute: async (_input, ctx) => {
				seen.push({ callId: ctx.callId, executionId: ctx.executionId });
				return { content: ctx.callId ?? "", isError: false };
			},
		});
		const agent = createAgent({ model: "faux", store: new SessionStore(mkdtempSync(join(tmpdir(), "kiso-ctxids-"))), tools: [peek], adapter: base });
		const session = await agent.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.run("go")) events.push(ev);
		const results = events.filter((e): e is Event & { type: "tool_result" } => e.type === "tool_result");
		const starts = events.filter((e): e is Event & { type: "tool_execution_started" } => e.type === "tool_execution_started");
		expect(seen.map((s) => s.callId).sort()).toEqual(["c-A", "c-B"]);
		for (const s of seen) {
			expect(results.some((r) => r.callId === s.callId && r.content === s.callId)).toBe(true);
			expect(starts.some((st) => st.callId === s.callId && st.executionId === s.executionId)).toBe(true);
		}
	});
});

describe("0.42.0: the append is evaluated exactly ONCE per provider attempt — the snapshot the model and the trace share", () => {
	it("two requests → two evaluations; each request's trace rent line measures the text that request was sent", async () => {
		let n = 0;
		const seen: (string | undefined)[] = [];
		const base = createFauxProvider([
			{ events: [{ type: "tool_call_end" as const, callId: "c1", name: "read_file", input: { path: "a" } }, { type: "stop" as const, reason: "tool_use" as const }] },
			{ events: [{ type: "text_delta" as const, text: "done" }, { type: "stop" as const, reason: "end_turn" as const }] },
		]);
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-once-")));
		const agent = createAgent({
			model: "faux",
			systemPrompt: "Base.",
			toolTable: "off",
			store,
			tools: [reader],
			extensions: [{ name: "stage", systemPrompt: { append: () => `n=${"x".repeat(++n)}` } }],
			adapter: { stream: (o: Parameters<typeof base.stream>[0]) => { seen.push(o.systemPrompt); return base.stream(o); } },
		});
		const session = await agent.session({ id: "once" });
		for await (const _ of session.run("go")) void _;
		await agent.close();
		// exactly one evaluation per attempt: the kernel reads its field twice
		// and the tracer reads the rent parts twice — none of those evaluate.
		expect(n).toBe(2);
		expect(seen).toEqual(["Base.\n\nn=x", "Base.\n\nn=xx"]);
		// the trace's rent line per request is the append THAT request was sent
		const lines = readFileSync(join(store.root, "traces", "once.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string; rent?: { surface: string; chars: number }[] });
		const rents = lines.filter((l) => l.kind === "request").map((l) => l.rent!.find((r) => r.surface === "system:ext:stage")!.chars);
		expect(rents).toEqual(["n=x".length, "n=xx".length]);
	});
});
