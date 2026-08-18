/**
 * EC-1 ② — the effects certificate, ENFORCED.
 *
 * The RED this file was written against: two edit_file calls on the SAME
 * path, in one committed turn, INTERLEAVE. The 0.1.26 window runs up to four
 * executions concurrently and nothing in the kernel knew that two writes to
 * one file must not overlap — SC-1b removed `concurrencySafe` precisely
 * because it was a declaration no code read, and handed the real race to
 * EC-1 with the instruction that the fix must not depend on a per-tool
 * opt-in for CORRECTNESS.
 *
 * So the certificate is inverted: absence is the safe state. An undeclared
 * tool is exclusive and the kernel serializes it behind a FIFO barrier
 * installed at ACCEPTANCE. A tool that declares `concurrency: "shared"`
 * buys its overlap back. Nothing a tool author forgets can create a race;
 * the most they can lose is throughput.
 *
 * The barrier is FIFO on purpose (no overtaking, ADR-0024 Amendment 3): a
 * later sibling — even a precommit-safe read — never jumps an exclusive
 * invocation ahead of it. Conservative first; overtaking and snapshot
 * semantics are future work, evidence-gated.
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import type { Event } from "../src/protocol/events.js";
import type { Message } from "../src/protocol/messages.js";
import { defineTool, type Tool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { loop } from "../src/kernel/loop.js";

const USER: Message = { role: "user", content: "go" };

/** A handler that records its own entry and exit around a real delay — the
 *  only way to SEE an interleave rather than infer it. */
function instrumented(name: string, ms: number, order: string[], effects?: Tool["effects"]): Tool {
	return defineTool({
		name,
		description: name,
		parameters: { type: "object", properties: { path: { type: "string" } } },
		...(effects !== undefined ? { effects } : {}),
		execute: async () => {
			order.push(`${name}:enter`);
			await new Promise((r) => setTimeout(r, ms));
			order.push(`${name}:exit`);
			return { content: name, isError: false };
		},
	});
}

async function runTurn(registry: ToolRegistry, calls: { callId: string; name: string; path: string }[]): Promise<Event[]> {
	const events: Event[] = [];
	for await (const ev of loop({
		adapter: createFauxProvider([
			{
				events: [
					...calls.map((c) => ({ type: "tool_call_end" as const, callId: c.callId, name: c.name, input: { path: c.path } })),
					{ type: "stop" as const, reason: "tool_use" as const },
				],
			},
			{ events: [{ type: "stop", reason: "end_turn" }] },
		]),
		model: "faux",
		registry,
		messages: [USER],
	})) {
		events.push(ev);
	}
	return events;
}

describe("EC-1 ② — an UNDECLARED tool is exclusive: the same-path write race is closed", () => {
	it("two edit_file calls on one path SERIALIZE, in call order (RED on base: they interleaved)", async () => {
		const order: string[] = [];
		const registry = new ToolRegistry();
		// The first call is slow, the second fast. Without a barrier the
		// second enters while the first is still inside its handler — the
		// interleave is deterministic, not a race the test hopes to catch.
		registry.register(instrumented("edit_file", 80, order));
		const events = await runTurn(registry, [
			{ callId: "a", name: "edit_file", path: "same.txt" },
			{ callId: "b", name: "edit_file", path: "same.txt" },
		]);
		// Serialized: each call's exit precedes the next call's enter.
		expect(order).toEqual(["edit_file:enter", "edit_file:exit", "edit_file:enter", "edit_file:exit"]);
		// And in CALL order — the barrier is FIFO, never a free-for-all.
		const started = events.filter((e) => e.type === "tool_execution_started");
		expect(started.map((e) => e.callId)).toEqual(["a", "b"]);
		// Both really ran; serialization is not silent dropping.
		expect(events.filter((e) => e.type === "tool_execution_succeeded")).toHaveLength(2);
	});

	it("a DECLARED-shared pair still overlaps — the certificate buys the throughput back", async () => {
		const order: string[] = [];
		const registry = new ToolRegistry();
		registry.register(instrumented("read_file", 80, order, { precommitSafe: true, concurrency: "shared" }));
		await runTurn(registry, [
			{ callId: "a", name: "read_file", path: "x.txt" },
			{ callId: "b", name: "read_file", path: "y.txt" },
		]);
		// Interleaved: both entered before either exited.
		expect(order.slice(0, 2)).toEqual(["read_file:enter", "read_file:enter"]);
	});

	it("an exclusive call BLOCKS a later shared sibling — FIFO, no overtaking", async () => {
		const order: string[] = [];
		const registry = new ToolRegistry();
		registry.register(instrumented("edit_file", 80, order));
		registry.register(instrumented("read_file", 5, order, { precommitSafe: true, concurrency: "shared" }));
		await runTurn(registry, [
			{ callId: "a", name: "edit_file", path: "same.txt" },
			{ callId: "b", name: "read_file", path: "same.txt" },
		]);
		// The read is fast and declared shared, but it was ACCEPTED after an
		// exclusive invocation — it waits. A read that overtook the write
		// would observe a half-written file, which is the whole point.
		expect(order).toEqual(["edit_file:enter", "edit_file:exit", "read_file:enter", "read_file:exit"]);
	});

	it("a shared call ahead of an exclusive one does not delay itself", async () => {
		const order: string[] = [];
		const registry = new ToolRegistry();
		registry.register(instrumented("read_file", 5, order, { precommitSafe: true, concurrency: "shared" }));
		registry.register(instrumented("edit_file", 20, order));
		await runTurn(registry, [
			{ callId: "a", name: "read_file", path: "x.txt" },
			{ callId: "b", name: "edit_file", path: "x.txt" },
		]);
		// The read is first in FIFO order and runs immediately; the write
		// waits for it (an exclusive invocation is alone while it runs).
		expect(order).toEqual(["read_file:enter", "read_file:exit", "edit_file:enter", "edit_file:exit"]);
	});
});
