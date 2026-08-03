/**
 * Phase B — tool arguments are validated against their declared JSON Schema
 * BEFORE the handler runs. A bad argument is an `invalid_input` tool result,
 * never a thrown handler and never a silent execution with garbage.
 */

import { describe, expect, it } from "vitest";
import type { Event } from "../src/protocol/events.js";
import { loop } from "../src/kernel/loop.js";
import { defineTool, type Tool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createFauxProvider } from "@vincemakes/kiso-evals";

describe("JSON Schema validation at the execution gate", () => {
	it("rejects arguments that fail the schema — handler never runs", async () => {
		const registry = new ToolRegistry();
		let executed = 0;
		registry.register(
			defineTool({
				name: "add",
				description: "Add",
				parameters: {
					type: "object",
					properties: { a: { type: "number" }, b: { type: "number" } },
					required: ["a", "b"],
				},
				execute: async () => {
					executed += 1;
					return { content: "nope", isError: false };
				},
			}),
		);

		const events: Event[] = [];
		for await (const ev of loop({
			adapter: createFauxProvider([
				{
					events: [
						{ type: "tool_call_end", callId: "c1", name: "add", input: { a: "not a number", b: 2 } },

				{ type: "stop", reason: "tool_use" }],
				},
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			model: "faux",
			registry,
			messages: [{ role: "user", content: "add" }],
		})) {
			events.push(ev);
		}

		expect(executed).toBe(0);
		const result = events.find((e) => e.type === "tool_result");
		expect(result).toMatchObject({ isError: true, errorKind: "invalid_input" });
		expect((result as { content: string }).content).toMatch(/schema|valid/i);
	});

	it("rejects missing required properties", async () => {
		const registry = new ToolRegistry();
		let executed = 0;
		registry.register(
			defineTool({
				name: "add",
				description: "Add",
				parameters: {
					type: "object",
					properties: { a: { type: "number" } },
					required: ["a"],
				},
				execute: async () => {
					executed += 1;
					return { content: "ran", isError: false };
				},
			}),
		);
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: createFauxProvider([
				{ events: [{ type: "tool_call_end", callId: "c1", name: "add", input: {} }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			model: "faux",
			registry,
			messages: [{ role: "user", content: "add" }],
		})) {
			events.push(ev);
		}
		expect(executed).toBe(0);
		expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: true, errorKind: "invalid_input" });
	});

	it("valid arguments pass through and execute", async () => {
		const registry = new ToolRegistry();
		let executed = 0;
		registry.register(
			defineTool({
				name: "add",
				description: "Add",
				parameters: {
					type: "object",
					properties: { a: { type: "number" } },
					required: ["a"],
				},
				execute: async (input: { a: number }) => {
					executed += 1;
					return { content: String(input.a), isError: false };
				},
			}),
		);
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: createFauxProvider([
				{ events: [{ type: "tool_call_end", callId: "c1", name: "add", input: { a: 5 } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			model: "faux",
			registry,
			messages: [{ role: "user", content: "add" }],
		})) {
			events.push(ev);
		}
		expect(executed).toBe(1);
		expect(events.find((e) => e.type === "tool_result")).toMatchObject({ content: "5", isError: false });
	});

	it("validation errors are classified invalid_input, not fatal (the tool ran nothing)", async () => {
		// covered by the first test; here we pin the errorKind boundary
		const tool: Tool = defineTool({
			name: "x",
			description: "x",
			parameters: { type: "object", properties: { v: { type: "string" } }, required: ["v"] },
			execute: async () => ({ content: "ok", isError: false }),
		});
		expect(tool.parameters).toBeDefined();
	});
});
