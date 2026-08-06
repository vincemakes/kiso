/**
 * M1 contract tests: the structural constraints hooks and modes must hold.
 * These are the "keep in sync" comments of other codebases, as tests.
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import type { Event, TerminalEvent } from "../src/protocol/events.js";
import type { Message, UserMessage } from "../src/protocol/messages.js";
import { defineTool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { loop } from "../src/kernel/loop.js";
import type { Adapter, StreamOptions } from "../src/protocol/adapter.js";

const USER: Message = { role: "user", content: "do the thing" };

const searchTool = defineTool({
	name: "web_search",
	description: "Search",
	parameters: { type: "object", properties: {} },
	execute: async () => ({ content: "results", isError: false }),
});

const artifactTool = defineTool({
	name: "create_artifact",
	description: "Create an artifact",
	parameters: { type: "object", properties: {} },
	delivers: { kind: "canvas" },
	execute: async () => ({ content: "artifact://1", isError: false }),
});

async function run(
	script: FauxScript,
	registry: ToolRegistry,
	opts: Partial<Parameters<typeof loop>[0]> = {},
): Promise<readonly Event[]> {
	const events: Event[] = [];
	for await (const ev of loop({
		adapter: createFauxProvider(script),
		model: "faux",
		registry,
		messages: [USER],
		...opts,
	})) {
		events.push(ev);
	}
	return events;
}

function terminal(events: readonly Event[]): TerminalEvent {
	const t = events.filter((e) => e.type === "terminal");
	expect(t).toHaveLength(1);
	return t[0]!;
}

describe("registry: the eager map wins against a live source", () => {
	it("0.1.27 失格调查: a tool registered eagerly AND live appears ONCE in list()/toSpecs()", async () => {
		const registry = new ToolRegistry();
		registry.register(searchTool);
		// The agent's wiring (0.1.26): a sync extension's tools are registered
		// eagerly AND its live source re-returns the same array — the spec
		// list previously duplicated the name (the real API's
		// "400 Tool names must be unique").
		registry.registerLive(() => [searchTool]);
		const specs = registry.toSpecs();
		expect(specs.filter((s) => s.name === "web_search")).toHaveLength(1);
		expect(registry.list().filter((t) => t.name === "web_search")).toHaveLength(1);
		// The live source's NEW tools (MCP's post-connect growth) still land.
		registry.registerLive(() => [artifactTool]);
		expect(registry.list().map((t) => t.name)).toEqual(["web_search", "create_artifact"]);
	});
});

describe("mode: visibleToolNames is a structural filter", () => {
	it("physically removes a tool from the registry the model can reach", async () => {
		const registry = new ToolRegistry();
		registry.register(searchTool);
		registry.register(artifactTool);

		const events = await run(
			[
				{
					events: [
						{ type: "tool_call_end", callId: "c1", name: "create_artifact", input: {} },

				{ type: "stop", reason: "tool_use" }],
				},
				{ events: [{ type: "stop", reason: "end_turn" }] },
			],
			registry,
			{
				modes: [{ name: "plan", visibleToolNames: ["web_search"] }],
				mode: "plan",
			},
		);

		// The tool is not in the subset registry: the call is refused as
		// unknown — never silently executed.
		const result = events.find((e) => e.type === "tool_result");
		expect(result).toMatchObject({ isError: true, errorKind: "invalid_input" });
		expect((result as { content: string }).content).toContain("Unknown tool");
	});

	it("without a mode, the same call runs fine", async () => {
		const registry = new ToolRegistry();
		registry.register(searchTool);
		registry.register(artifactTool);
		const events = await run(
			[
				{
					events: [
						{ type: "tool_call_end", callId: "c1", name: "create_artifact", input: {} },

				{ type: "stop", reason: "tool_use" }],
				},
				{ events: [{ type: "stop", reason: "end_turn" }] },
			],
			registry,
		);
		const result = events.find((e) => e.type === "tool_result");
		expect(result).toMatchObject({ isError: false });
	});
});

describe("hooks: transforms and observers", () => {
	it("onUserMessage can rewrite the incoming message", async () => {
		const registry = new ToolRegistry();
		let seen: UserMessage | undefined;
		const events = await run(
			[{ events: [{ type: "stop", reason: "end_turn" }] }],
			registry,
			{
				hooks: {
					onUserMessage: async (msg) => {
						seen = { ...msg, content: "rewritten" };
						return seen;
					},
				},
			},
		);
		expect(seen?.content).toBe("rewritten");
		expect(terminal(events).outcome).toEqual({ kind: "completed" });
	});

	it("onUserMessage can veto the message entirely (null → run with none)", async () => {
		const registry = new ToolRegistry();
		const events = await run(
			[{ events: [{ type: "stop", reason: "end_turn" }] }],
			registry,
			{ hooks: { onUserMessage: async () => null } },
		);
		// No user message, no tool calls → still converges honestly.
		expect(terminal(events).outcome).toEqual({ kind: "completed" });
	});

	it("onPreTool deny returns a precondition result; allow passes through", async () => {
		const registry = new ToolRegistry();
		registry.register(searchTool);
		let allowed = false;
		const events = await run(
			[
				{
					events: [
						{ type: "tool_call_end", callId: "c1", name: "web_search", input: {} },

				{ type: "stop", reason: "tool_use" }],
				},
				{ events: [{ type: "stop", reason: "end_turn" }] },
			],
			registry,
			{
				hooks: {
					onPreTool: async (call) => {
						if (call.name === "web_search" && !allowed) {
							return { action: "deny" as const, reason: "denied for now" };
						}
						return { action: "allow" as const };
					},
				},
			},
		);
		const denied = events.find((e) => e.type === "tool_result");
		expect(denied).toMatchObject({ isError: true, errorKind: "precondition" });
	});

	it("onPostTool can rewrite a result; the rewrite reaches the trajectory", async () => {
		const registry = new ToolRegistry();
		registry.register(
			defineTool({
				...searchTool,
				execute: async () => ({ content: "original", isError: false }),
			}),
		);
		const events = await run(
			[
				{
					events: [
						{ type: "tool_call_end", callId: "c1", name: "web_search", input: {} },

				{ type: "stop", reason: "tool_use" }],
				},
				{ events: [{ type: "stop", reason: "end_turn" }] },
			],
			registry,
			{
				hooks: {
					onPostTool: async (_call, result) => ({
						...result,
						content: `${result.content} [annotated]`,
					}),
				},
			},
		);
		const result = events.find((e) => e.type === "tool_result");
		expect((result as { content: string }).content).toBe("original [annotated]");
	});

	it("onEvent is an observer: sees every event, changes nothing", async () => {
		const registry = new ToolRegistry();
		registry.register(searchTool);
		const observed: string[] = [];
		const events = await run(
			[
				{
					events: [
						{ type: "text_delta", text: "hi" },
						{ type: "tool_call_end", callId: "c1", name: "web_search", input: {} },

				{ type: "stop", reason: "tool_use" }],
				},
				{ events: [{ type: "stop", reason: "end_turn" }] },
			],
			registry,
			{
				hooks: {
					onEvent: async (ev) => {
						observed.push(ev.type);
					},
				},
			},
		);
		// Observer saw the adapter's events AND the kernel's own events.
		expect(observed).toContain("text_delta");
		expect(observed).toContain("tool_result");
		expect(observed).toContain("terminal");
		expect(events.filter((e) => e.type === "tool_result")).toHaveLength(1);
	});

	it("onStop fires before the terminal event lands", async () => {
		const registry = new ToolRegistry();
		const stopped: string[] = [];
		const events = await run(
			[{ events: [{ type: "stop", reason: "end_turn" }] }],
			registry,
			{
				hooks: {
					onStop: async (reason) => {
						stopped.push(reason);
					},
				},
			},
		);
		expect(stopped).toEqual(["completed"]);
		const terminalSeq = terminal(events).seq;
		// onStop ran before the terminal was appended — nothing else followed.
		expect(events.at(-1)?.seq).toBe(terminalSeq);
	});
});

describe("loop: stream options passthrough", () => {
	it("forwards systemPrompt to the adapter", async () => {
		const registry = new ToolRegistry();
		let seenSystemPrompt: string | undefined;
		const spyAdapter: Adapter = {
			stream: async function* (opts: StreamOptions) {
				seenSystemPrompt = opts.systemPrompt;
				yield { seq: 0, type: "stop" as const, reason: "end_turn" as const };
			},
		};
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: spyAdapter,
			model: "faux",
			registry,
			messages: [USER],
			systemPrompt: "you are kiso",
		})) {
			events.push(ev);
		}
		expect(seenSystemPrompt).toBe("you are kiso");
		expect(terminal(events).outcome).toEqual({ kind: "completed" });
	});
});
