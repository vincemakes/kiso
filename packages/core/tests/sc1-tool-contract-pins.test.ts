/**
 * SC-1 (the semantic contract audit) — the pins that keep the TOOL
 * contract's PROSE honest.
 *
 * Every assertion here records SHIPPED behavior. Each is the red for a
 * doc-comment that used to claim otherwise, so the words cannot drift back
 * without a test going red.
 *
 * `concurrencySafe` is INERT — declared on the contract, consulted by
 * nothing. tools/tool.ts's header used to say it "decides batch
 * scheduling"; the scheduler restored by ADR-0024 Amendment 1 runs a FIXED
 * window of 4 and never asks a tool whether it is parallel-safe.
 *
 * READ THIS BEFORE CHANGING IT: these two cases pin the CURRENT state, not
 * a desired one. Whether to wire the predicate or retire it is an OPEN
 * contract decision. If it is ever wired, THIS file is what must change —
 * deliberately, as part of that ruling, never as collateral damage.
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

/** A tool that sleeps `ms` and DECLARES itself unsafe to parallelize —
 *  the strongest declaration the contract offers. `asked` counts every
 *  time the kernel consults the predicate. */
function unsafeSlowTool(name: string, ms: number, asked: { count: number }): Tool {
	return defineTool({
		name,
		description: name,
		parameters: { type: "object", properties: {} },
		concurrencySafe: () => {
			asked.count += 1;
			return false;
		},
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

describe("SC-1 — `concurrencySafe` is declared but never consulted", () => {
	it("the kernel NEVER invokes the predicate, however many calls a turn makes", async () => {
		const asked = { count: 0 };
		const registry = new ToolRegistry();
		registry.register(unsafeSlowTool("t1", 5, asked));
		registry.register(unsafeSlowTool("t2", 5, asked));
		registry.register(unsafeSlowTool("t3", 5, asked));

		const events = await runTurn(registry);

		// All three really executed — the turn is a normal, complete one.
		expect(events.filter((e) => e.type === "tool_execution_succeeded")).toHaveLength(3);
		// And the contract's scheduling predicate was asked exactly nothing.
		expect(asked.count).toBe(0);
	});

	it("declaring `concurrencySafe: () => false` does NOT serialize — the fixed window still overlaps them", async () => {
		const asked = { count: 0 };
		const registry = new ToolRegistry();
		registry.register(unsafeSlowTool("t1", 300, asked));
		registry.register(unsafeSlowTool("t2", 300, asked));
		registry.register(unsafeSlowTool("t3", 300, asked));

		const t0 = Date.now();
		const events = await runTurn(registry);
		const dt = Date.now() - t0;

		// Serial would be ~900ms. Honouring the predicate is what serial
		// LOOKS like; the shipped kernel ignores it and runs the same
		// window-of-4 schedule as any other turn (the same < 60% bound the
		// parallel acceptance uses).
		expect(dt).toBeLessThan(540);
		expect(events.filter((e) => e.type === "tool_execution_succeeded")).toHaveLength(3);
		expect(asked.count).toBe(0);
	});
});
