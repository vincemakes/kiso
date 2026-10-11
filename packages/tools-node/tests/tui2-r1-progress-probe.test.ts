/**
 * TUI2-R1 slice ① — THE C PROBE, executable.
 *
 * Feature C (a running shell shows a live output tail) needs output
 * BEFORE the call settles. The round's stop clause says: confirm what
 * the contract offers, and escalate rather than improvise. This file is
 * that confirmation, pinned as a test so a future round cannot quietly
 * grow an incremental channel and leave the sidecar as dead weight — nor
 * quietly remove `sessionId` and leave the sidecar unkeyable.
 *
 * The three findings, each asserted below:
 *
 *   ①a  `Tool.execute` returns ONE `ToolResult`, at completion. There is
 *       no yield, no callback, no stream — a command that prints for two
 *       seconds hands the terminal nothing until it exits.
 *
 *   ①b  `ToolContext` offers NO progress surface. The kernel constructs
 *       it as `{ signal, sessionId? }` plus — since 0.42.0 (DECLARED
 *       SUPERSESSION, the products' request #9) — this invocation's
 *       `callId` and `executionId`. The declared `meta` field is NEVER
 *       populated. A tool still cannot emit, and cannot be handed a sink
 *       to emit into: the ids name the call, they are not a channel.
 *
 *   ①c  — the finding that shaped the 0.13-era design — the executionId
 *       was NOT reachable from inside a tool: allocated kernel-side at
 *       the drain and never passed down, so the sanctioned sidecar
 *       "keyed by executionId" was not implementable without a core
 *       line. SUPERSEDED in 0.42.0: the kernel now hands the tool its
 *       executionId (it is allocated before execute runs). The derived
 *       key below stays as built — changing the sidecar's key is its own
 *       round — and this probe now pins the NEW fact.
 *
 * THE DESIGN THE PROBE LANDS (zero core/runtime lines, zero new contract
 * surface): the sidecar is keyed by what BOTH sides already hold — the
 * `sessionId` the contract already carries into `execute`, and the
 * `command` argument itself, which the TUI has verbatim in the running
 * cell's input. `shellProgressKey(sessionId, command)` is that derived
 * key (tools-node/src/index.ts); the writer is the shell tool, the
 * reader is the CLI, and neither needs the kernel to tell it anything
 * new. The trace-sidecar precedent holds unchanged: an observation file
 * never feeds correctness, and its absence is never an error.
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { ToolRegistry, defineTool, loop, type Event, type ToolContext } from "@vincemakes/kiso-core";
import { shellTool } from "../src/index.js";
import { seedLog } from "@vincemakes/kiso-runtime";

describe("TUI2-R1 ① — the C probe: the tool contract has no incremental output channel", () => {
	it("①a a long-running shell yields NOTHING before it settles — one result, at completion", async () => {
		const seen: string[] = [];
		const started = Date.now();
		const call = shellTool({ workspaceRoot: process.cwd() }).execute(
			{ command: "printf 'first\\n'; sleep 0.4; printf 'second\\n'" },
			{ signal: new AbortController().signal },
		);
		// the observation window: mid-run, the tool has offered the caller
		// nothing at all — there is no channel on which it could.
		await new Promise((r) => setTimeout(r, 200));
		seen.push(`mid-run after ${Date.now() - started}ms: nothing observable`);
		const result = await call;
		expect(seen).toHaveLength(1);
		// everything arrives at once, at the end
		expect(result.content).toContain("first");
		expect(result.content).toContain("second");
	});

	it("①b ToolContext offers no progress surface — the kernel passes signal, sessionId and (0.42.0) the call's ids, nothing else", async () => {
		let captured: ToolContext | null = null;
		const registry = new ToolRegistry();
		registry.register(
			defineTool<Record<string, never>>({
				name: "probe",
				description: "records the ToolContext the kernel hands it",
				parameters: { type: "object", properties: {} },
				execute: async (_input, ctx) => {
					captured = ctx;
					return { content: "ok", isError: false };
				},
			}),
		);
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: createFauxProvider([
				{ events: [{ type: "tool_call_end", callId: "c1", name: "probe", input: {} }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			model: "faux-model",
			registry,
			log: seedLog([{ role: "user", content: "probe" }]),
			sessionId: "s-probe",
		})) {
			events.push(ev);
		}
		expect(captured).not.toBeNull();
		const ctx = captured as unknown as Record<string, unknown>;
		// the populated set, exactly: no emit, no onOutput, no write, no
		// progress, no stream — and `meta` (the declared free-form field)
		// is never populated by the kernel.
		expect(Object.keys(ctx).sort()).toEqual(["callId", "executionId", "sessionId", "signal"]);
		expect(ctx.meta).toBeUndefined();
		for (const channel of ["emit", "onOutput", "progress", "write", "stream", "push"]) {
			expect(ctx[channel], `ToolContext must not offer a ${channel} channel`).toBeUndefined();
		}
	});

	it("①c (superseded 0.42.0) the tool now sees the executionId its events are keyed by, and the callId", async () => {
		let captured: ToolContext | null = null;
		const registry = new ToolRegistry();
		registry.register(
			defineTool<Record<string, never>>({
				name: "probe",
				description: "records the ToolContext the kernel hands it",
				parameters: { type: "object", properties: {} },
				execute: async (_input, ctx) => {
					captured = ctx;
					return { content: "ok", isError: false };
				},
			}),
		);
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: createFauxProvider([
				{ events: [{ type: "tool_call_end", callId: "c1", name: "probe", input: {} }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			model: "faux-model",
			registry,
			log: seedLog([{ role: "user", content: "probe" }]),
			sessionId: "s-probe",
		})) {
			events.push(ev);
		}
		// the id EXISTS — every execution event carries it, which is how the
		// CLI knows which cell is running…
		const started = events.filter((e) => e.type === "tool_execution_started");
		expect(started).toHaveLength(1);
		const startedId = (started[0] as unknown as { executionId: string }).executionId;
		expect(typeof startedId).toBe("string");
		// 0.42.0: it IS in what the tool was handed, equal to the event's — and
		// so is the model's callId. The derived sidecar key stays as built.
		const ctx = captured as unknown as { callId?: string; executionId?: string };
		expect(ctx.executionId).toBe(startedId);
		expect(ctx.callId).toBe("c1");
	});
});
