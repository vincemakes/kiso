/**
 * Incident suite: every fixture runs on the REAL loop and must satisfy its
 * requiredTerminal + (where present) delivery/assert expectations. These are
 * the failures kiso promises to be verifiable against — the README's claim.
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider } from "../src/faux.js";
import type { Event, TerminalEvent } from "@vincemakes/kiso-core";
import { defineTool } from "@vincemakes/kiso-core";
import { ToolRegistry } from "@vincemakes/kiso-core";
import { loop } from "@vincemakes/kiso-core";
import { FIXTURES, runStaticFixture } from "../src/fixtures/index.js";
import { makeAbortSignal } from "../src/fixtures/user-abort.js";

const USER = { role: "user" as const, content: "do the thing" };

async function runFixture(name: string, extra: Partial<Parameters<typeof loop>[0]> = {}): Promise<readonly Event[]> {
	const fixture = FIXTURES.find((f) => f.name === name)!;
	const events: Event[] = [];
	for await (const ev of loop({
		adapter: createFauxProvider(fixture.script),
		model: "faux",
		registry: extra.registry ?? new ToolRegistry(),
		messages: [USER],
		...extra,
	})) {
		events.push(ev);
	}
	return events;
}

const terminalOf = (events: readonly Event[]) =>
	events.filter((e): e is TerminalEvent => e.type === "terminal").at(-1)!;

describe("incident suite on the real loop", () => {
	it("every fixture's static check passes (shape reproduced)", () => {
		for (const fixture of FIXTURES) {
			const result = runStaticFixture(fixture);
			expect(result.violations, `${fixture.name}: ${fixture.incident}`).toEqual([]);
		}
	});

	it("terminal-lies: honest completed + delivery verdict fails", async () => {
		const events = await runFixture("terminal-lies");
		expect(terminalOf(events).outcome).toEqual({ kind: "completed" });
		const fixture = FIXTURES.find((f) => f.name === "terminal-lies")!;
		expect(fixture.assert?.(events) ?? []).toEqual([]);
	});

	it("silent-tool-failure: the error stays visible with its kind", async () => {
		const registry = new ToolRegistry();
		registry.register(
			defineTool({
				name: "web_search",
				description: "s",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: "overloaded", isError: true, errorKind: "transient" as const }),
			}),
		);
		const events = await runFixture("silent-tool-failure", { registry });
		const err = events.find((e) => e.type === "tool_result" && e.isError);
		expect(err).toMatchObject({ errorKind: "transient" });
		expect(terminalOf(events).outcome).toEqual({ kind: "completed" });
	});

	it("user-abort: flipping the signal lands on an honest aborted terminal", async () => {
		const { signal, flip } = makeAbortSignal(0);
		// Flip after the first event reaches the consumer — mid-stream.
		const events: Event[] = [];
		const fixture = FIXTURES.find((f) => f.name === "user-abort")!;
		for await (const ev of loop({
			adapter: createFauxProvider(fixture.script),
			model: "faux",
			registry: new ToolRegistry(),
			messages: [USER],
			signal,
		})) {
			events.push(ev);
			if (events.length === 1) flip();
		}
		const terminal = terminalOf(events);
		expect(terminal.outcome).toMatchObject({ kind: "aborted", by: "user" });
		// An aborted run never executes the pending tool call.
		//
		// EC-1: this property is unchanged and still holds — what changed is
		// how it is MEASURED. The old assertion counted `tool_result` events
		// and expected none, which was a leaky proxy: a protocol REFUSAL
		// produces a tool_result too, without anything running. This fixture's
		// registry is empty on purpose, so its call is refused as an unknown
		// tool, and that refusal is computed synchronously — before any abort
		// check, because there is no tool to check anything about.
		//
		// The refusal now reaches the consumer where it used to be stranded.
		// Cause: EC-1 ③ moved `acquireWindow()` off the front of the launch
		// (waiting must consume no execution slot, invariant 6), which removes
		// a microtask hop before the decide, so the queued refusal is drained
		// by the next stream event instead of dying with the returning loop.
		// No abort re-check was weakened: the ones in decideCall and in
		// runLedgered — before the started event and again before the handler
		// — are byte-unchanged, and a signal that would have stopped a launch
		// still stops it.
		//
		// So the assertion is tightened to the property the comment actually
		// claims: nothing EXECUTED. That is the honest measurement, and it is
		// strictly stronger than the event count it replaces.
		expect(events.filter((e) => e.type === "tool_execution_started")).toHaveLength(0);
		expect(events.filter((e) => e.type === "tool_execution_succeeded")).toHaveLength(0);
		// The only model-facing result is the refusal — never an execution's.
		for (const r of events.filter((e) => e.type === "tool_result")) {
			expect(r).toMatchObject({ isError: true, errorKind: "invalid_input" });
		}
	});

	it("unknown-tool: the ghost call is refused as invalid_input, nothing vanishes", async () => {
		const events = await runFixture("unknown-tool");
		const refusal = events.find((e) => e.type === "tool_result" && e.isError);
		expect(refusal).toMatchObject({ errorKind: "invalid_input" });
		expect((refusal as { content: string }).content).toContain("Unknown tool");
		expect(terminalOf(events).outcome).toEqual({ kind: "completed" });
	});

	it("permission-negotiation: deny then allow — two distinct outcomes, same shape", async () => {
		const registry = new ToolRegistry();
		registry.register(
			defineTool({
				name: "code_execute",
				description: "run code",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: "2", isError: false }),
			}),
		);
		let approved = false;
		const events = await runFixture("permission-negotiation", {
			registry,
			hooks: {
				onPreTool: async () => {
					if (!approved) {
						approved = true;
						return { action: "deny" as const, reason: "needs approval" };
					}
					return { action: "allow" as const };
				},
			},
		});
		const results = events.filter((e) => e.type === "tool_result");
		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({ isError: true, errorKind: "precondition" });
		expect(results[1]).toMatchObject({ isError: false });
	});
});
