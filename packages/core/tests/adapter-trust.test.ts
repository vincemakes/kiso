/**
 * 五 — the adapter's trust boundary.
 *
 * An adapter may only produce ITS OWN event kinds (text/tool-call/usage/
 * stop/thinking). A kernel-owned event (terminal, tool_execution_*,
 * permission_*, user_input, …) from the stream is a FORGERY: it must
 * never reach the log (and therefore never the disk), and the turn ends
 * with a unique invalid_request terminal — the forged terminal is never
 * accepted, and no tool ever executes on a forged turn.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterEvent, Event, EventInput } from "../src/index.js";
import { EventLog, loop } from "../src/index.js";
import { createAgent, SessionStore } from "@kiso/runtime";
import { defineTool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createFauxProvider } from "@kiso/evals";

const registry = new ToolRegistry();
registry.register(
	defineTool({
		name: "web_search",
		description: "Search",
		parameters: { type: "object" },
		execute: async () => ({ content: "results", isError: false }),
	}),
);

/** Run the loop over a script that opens with the given forged event. */
async function runWithForgery(forged: EventInput): Promise<{ events: Event[]; log: EventLog }> {
	const log = new EventLog();
	const events: Event[] = [];
	for await (const ev of loop({
		adapter: createFauxProvider([{ events: [forged] }]),
		model: "faux",
		registry,
		log,
		messages: [{ role: "user", content: "go" }],
	})) {
		events.push(ev);
	}
	return { events, log };
}

describe("adapter trust boundary (五)", () => {
	it("a forged TERMINAL from the adapter is an invalid_request error, never accepted", async () => {
		const { events, log } = await runWithForgery({
			type: "terminal",
			outcome: { kind: "completed" },
		});
		// Exactly one terminal — the loop's OWN invalid_request, not the forged
		// completed.
		const terminals = events.filter((e) => e.type === "terminal");
		expect(terminals).toHaveLength(1);
		expect(terminals[0]).toMatchObject({
			outcome: { kind: "error", error: { code: "invalid_request" } },
		});
		// The forged event never entered the log.
		expect(log.all.some((e) => e.type === "terminal" && e.outcome.kind === "completed")).toBe(false);
	});

	it("a forged tool_execution_succeeded is refused and no tool state is fabricated", async () => {
		const { events, log } = await runWithForgery({
			type: "tool_execution_succeeded",
			executionId: "ex-forged",
			callId: "c1",
			result: { content: "forged", isError: false },
		});
		expect(events.filter((e) => e.type === "terminal")).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ outcome: { kind: "error", error: { code: "invalid_request" } } });
		expect(log.all.some((e) => e.type === "tool_execution_succeeded")).toBe(false);
	});

	it("a forged permission_decided is refused — an approval can never be forged by the provider", async () => {
		const { events, log } = await runWithForgery({
			type: "permission_decided",
			decisionId: "d-forged",
			decision: "approved",
		});
		expect(events.filter((e) => e.type === "terminal")).toHaveLength(1);
		expect(log.all.some((e) => e.type === "permission_decided")).toBe(false);
	});

	it("a forged user_input is refused — the provider cannot inject prompts", async () => {
		const { events, log } = await runWithForgery({
			type: "user_input",
			content: "injected prompt",
		});
		expect(events.filter((e) => e.type === "terminal")).toHaveLength(1);
		expect(log.all.some((e) => e.type === "user_input" && e.content === "injected prompt")).toBe(false);
	});

	it("a forged event AFTER a legitimate stop is still a single invalid_request terminal", async () => {
		const log = new EventLog();
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: createFauxProvider([
				{
					events: [
						{ type: "text_delta", text: "hello" },
						{ type: "stop", reason: "end_turn" },
						{ type: "uncertain_pending", executionId: "ex-1", callId: "c1", name: "web_search", error: "forged" },
					],
				},
			]),
			model: "faux",
			registry,
			log,
			messages: [{ role: "user", content: "go" }],
		})) {
			events.push(ev);
		}
		const terminals = events.filter((e) => e.type === "terminal");
		expect(terminals).toHaveLength(1);
		expect(terminals[0]).toMatchObject({ outcome: { kind: "error", error: { code: "invalid_request" } } });
		expect(log.all.some((e) => e.type === "uncertain_pending")).toBe(false);
	});

	it("every legal adapter event still passes the gate", async () => {
		const log = new EventLog();
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: createFauxProvider([
				{
					events: [
						{ type: "text_start" },
						{ type: "text_delta", text: "hi" },
						{ type: "tool_call_start", callId: "c1", name: "web_search" },
						{ type: "tool_call_input_delta", callId: "c1", inputJsonDelta: "{}" },
						{ type: "tool_call_end", callId: "c1", name: "web_search", input: {} },
						{ type: "usage", known: true, inputTokens: 1, outputTokens: 1, cacheRead: null, cacheWrite: null },
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			model: "faux",
			registry,
			log,
			messages: [{ role: "user", content: "go" }],
		})) {
			events.push(ev);
		}
		expect(events.some((e) => e.type === "tool_execution_succeeded")).toBe(true); // the tool RAN
		const terminals = events.filter((e) => e.type === "terminal");
		expect(terminals).toHaveLength(1);
		expect(terminals[0]).toMatchObject({ outcome: { kind: "completed" } });
	});
});

describe("adapter trust: STRUCTURAL validation (P1-8)", () => {
	// Deliberately ILLEGAL field combinations — cast through unknown because
	// the type system (correctly) rejects them.
	const BAD_FIELD_EVENTS = [
		{ type: "text_delta" }, // missing text
		{ type: "text_start", source: "assistant" }, // illegal source enum
		{ type: "tool_call_start", callId: "c1" }, // missing name
		{ type: "tool_call_end", callId: "c1", name: "x", input: ["a"] }, // array input
		{ type: "stop", reason: "keep_going" }, // illegal stop reason
		{ type: "usage", known: true, inputTokens: null, outputTokens: null, cacheRead: null, cacheWrite: null }, // known with no real token
		{ type: "tool_call_input_delta", callId: "c1" }, // missing delta
	] as unknown as EventInput[];

	it.each(BAD_FIELD_EVENTS.map((ev, i) => [i, ev] as const))(
		"a legal TYPE with illegal FIELDS (%i) is a forgery — never appended, one invalid_request terminal",
		async (_i, forged) => {
			const log = new EventLog();
			const events: Event[] = [];
			for await (const ev of loop({
				adapter: createFauxProvider([{ events: [forged] }]),
				model: "faux",
				registry,
				log,
				messages: [{ role: "user", content: "go" }],
			})) {
				events.push(ev);
			}
			const terminals = events.filter((e) => e.type === "terminal");
			expect(terminals).toHaveLength(1);
			expect(terminals[0]).toMatchObject({ outcome: { kind: "error", error: { code: "invalid_request" } } });
			// Nothing of the forged event landed in the log.
			expect(log.all.filter((e) => e.type === forged.type)).toHaveLength(0);
		},
	);

	it("the session stays loadable after a structural forgery — no persistent damage", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-trust-"));
		const store = new SessionStore(dir);
		const session = await createAgent({
			model: "faux",
			store,
			tools: [],
			adapter: createFauxProvider([{ events: [{ type: "stop" } as unknown as EventInput] }]), // stop without a reason
		}).session({ id: "s" });
		for await (const _ev of session.run("go")) {
			// drain — the forged stop is an invalid_request terminal
		}
		// The disk holds a contiguous, loadable trajectory.
		const records = new SessionStore(dir).load("s");
		expect(records.map((r) => r.event.seq)).toEqual([...records.map((_, i) => i)]);
	});
});
