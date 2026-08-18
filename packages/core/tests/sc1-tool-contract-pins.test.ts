/**
 * SC-1 (the semantic contract audit) — the pins that keep the TOOL
 * contract's PROSE honest.
 *
 * Every assertion here records SHIPPED behavior. Each is the red for a
 * doc-comment that used to claim otherwise, so the words cannot drift back
 * without a test going red.
 *
 * SC-1b UPDATE (0.12.0). SC-1's version of this file pinned that
 * `concurrencySafe` was INERT — declared on the contract, consulted by
 * nothing — and said: "Whether to wire the predicate or retire it is an
 * OPEN contract decision. If it is ever wired, THIS file is what must
 * change — deliberately, as part of that ruling, never as collateral
 * damage." The decision was taken the other way: the SC-1 memo's
 * adjudication RETIRED the field at 0.12.0, so this file changes under
 * exactly the clause it wrote for itself.
 *
 * What retirement did NOT change is the behavior the old pins measured,
 * which is why the measurement stays here under new prose: the kernel
 * schedules a FIXED window of `WINDOW_SIZE = 4` concurrent executions
 * (kernel/loop.ts) and asks no tool for permission. Before, three tools
 * declaring themselves unsafe overlapped anyway; now there is no way to
 * declare it at all — and the schedule is the same schedule, which is the
 * point. The pin below is therefore the CURRENT state and the evidence
 * that removing the field moved nothing.
 *
 * The concurrency RACE the field was mistaken for a defense against is
 * real and OPEN — it is EC-1's question, and EC-1 owes a mechanism that
 * does not depend on a per-tool opt-in (a per-CALL judgment is what a
 * static per-tool flag could never express; that is why the flag was the
 * wrong shape, not merely an unwired one).
 *
 * Already pinned elsewhere, cited rather than duplicated:
 *   - no (name, input) dedup, a repeat is a new execution and runs —
 *     packages/runtime/tests/execution.test.ts, "the same tool+input
 *     issued TWICE is two logical calls — both execute";
 *   - `idempotent`'s two real effects (the honest note on a non-idempotent
 *     failure; `safeToRetry` on the receipt) and failed != uncertain —
 *     packages/runtime/tests/execution.test.ts, the ruling #12 / ADR-0038
 *     trio;
 *   - `uncertain_pending` is never emitted — packages/core/tests/
 *     execution-gate.test.ts (C3) and packages/runtime/tests/execution.test.ts.
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import type { Event } from "../src/protocol/events.js";
import type { Message } from "../src/protocol/messages.js";
import { defineTool, type Tool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { loop } from "../src/kernel/loop.js";

const USER: Message = { role: "user", content: "hi" };

/** A tool that sleeps `ms`. There is no longer any way for it to ask the
 *  kernel for isolation — that is the retirement, expressed in the fixture. */
function slowTool(name: string, ms: number): Tool {
	return defineTool({
		name,
		description: name,
		parameters: { type: "object", properties: {} },
		execute: async () => {
			await new Promise((r) => setTimeout(r, ms));
			return { content: name, isError: false };
		},
	});
}

async function runTurn(registry: ToolRegistry): Promise<Event[]> {
	const script = [
		{
			events: [
				{ type: "tool_call_end" as const, callId: "a", name: "t1", input: {} },
				{ type: "tool_call_end" as const, callId: "b", name: "t2", input: {} },
				{ type: "tool_call_end" as const, callId: "c", name: "t3", input: {} },
				{ type: "stop" as const, reason: "tool_use" as const },
			],
		},
		{ events: [{ type: "stop" as const, reason: "end_turn" as const }] },
	];
	const events: Event[] = [];
	for await (const ev of loop({
		adapter: createFauxProvider(script),
		model: "faux",
		registry,
		messages: [USER],
	})) {
		events.push(ev);
	}
	return events;
}

describe("SC-1b — the schedule is the kernel's alone; no tool has a say", () => {
	it("three tools in one turn all execute — a normal, complete turn", async () => {
		const registry = new ToolRegistry();
		registry.register(slowTool("t1", 5));
		registry.register(slowTool("t2", 5));
		registry.register(slowTool("t3", 5));

		const events = await runTurn(registry);

		expect(events.filter((e) => e.type === "tool_execution_succeeded")).toHaveLength(3);
	});

	it("they OVERLAP — the fixed window of 4, unchanged by the retirement", async () => {
		const registry = new ToolRegistry();
		registry.register(slowTool("t1", 300));
		registry.register(slowTool("t2", 300));
		registry.register(slowTool("t3", 300));

		const t0 = Date.now();
		const events = await runTurn(registry);
		const dt = Date.now() - t0;

		// Serial would be ~900ms. This is the SAME bound SC-1 measured while
		// all three declared `concurrencySafe: () => false` — the declaration
		// never bought the isolation it looked like it bought (the same < 60%
		// bound the parallel acceptance uses).
		expect(dt).toBeLessThan(540);
		expect(events.filter((e) => e.type === "tool_execution_succeeded")).toHaveLength(3);
	});
});
