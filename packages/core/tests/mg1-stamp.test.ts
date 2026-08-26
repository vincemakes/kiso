/**
 * MG-1 (ADR-0051 Amendment 5) — the kernel's half of the envelope.
 *
 * The kernel stamps `scope` at the Turn Commit append (adapters cannot
 * forge it), strips adapter-emitted continuation on an unscoped run, and
 * enforces the two caps at the trust boundary: optional entries drop
 * WHOLE at the soft cap with a durable `truncated: true`; a required set
 * over the hard cap VOIDS the turn before commit (no durable turn exists
 * that is known unable to continue correctly). The projection attaches a
 * committed stop's envelope to its flushed assistant message.
 *
 * RED on the pre-MG-1 tree: nothing stamps, strips, caps, or attaches.
 */

import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/protocol/adapter.js";
import type { Continuation, ContinuationScope, Event } from "../src/protocol/events.js";
import { loop } from "../src/kernel/loop.js";
import { projectMessages } from "../src/kernel/project.js";
import { ToolRegistry } from "../src/tools/registry.js";

const RUN_SCOPE: ContinuationScope = { providerId: "anthropic", apiId: "anthropic-messages", modelId: "claude-x" };
const FORGED_SCOPE: ContinuationScope = { providerId: "evil", apiId: "evil-api", modelId: "evil-model" };

function stopWith(continuation: Continuation): Adapter {
	return {
		stream: async function* () {
			yield { seq: 0, type: "text_delta", text: "answer" } as never;
			yield { seq: 0, type: "stop", reason: "end_turn", continuation } as never;
		},
	};
}

async function collect(adapter: Adapter, scope?: ContinuationScope): Promise<readonly Event[]> {
	const events: Event[] = [];
	for await (const ev of loop({
		adapter,
		model: "claude-x",
		registry: new ToolRegistry(),
		messages: [{ role: "user", content: "go" }],
		...(scope !== undefined ? { continuationScope: scope } : {}),
	})) {
		events.push(ev);
	}
	return events;
}

const stopOf = (events: readonly Event[]) => events.find((e) => e.type === "stop") as (Event & { continuation?: Continuation }) | undefined;

describe("MG-1 — kernel scope stamping", () => {
	it("overwrites the adapter's scope with the run's configured scope", async () => {
		const events = await collect(
			stopWith({ scope: FORGED_SCOPE, entries: [{ kind: "anthropic.content_block", required: true, data: "d" }] }),
			RUN_SCOPE,
		);
		const stop = stopOf(events);
		expect(stop?.continuation?.scope).toEqual(RUN_SCOPE);
		expect(stop?.continuation?.entries.length).toBe(1);
	});

	it("strips adapter-emitted continuation on an UNSCOPED run (SDK/faux posture)", async () => {
		const events = await collect(stopWith({ scope: FORGED_SCOPE, entries: [{ kind: "x", required: false, data: "d" }] }));
		expect(stopOf(events)?.continuation).toBeUndefined();
	});
});

describe("MG-1 — the two caps at the trust boundary", () => {
	it("optional entries drop WHOLE at the soft cap, earliest first, truncated: true durable", async () => {
		const big = "x".repeat(200 * 1024);
		const events = await collect(
			stopWith({
				scope: RUN_SCOPE,
				entries: [
					{ kind: "openai.reasoning_item", required: false, data: big },
					{ kind: "openai.reasoning_item", required: false, data: big },
					{ kind: "anthropic.content_block", required: true, data: "small-required" },
				],
			}),
			RUN_SCOPE,
		);
		const c = stopOf(events)?.continuation;
		expect(c?.truncated).toBe(true);
		expect(c?.entries.some((e) => e.required && e.data === "small-required"), "required survives").toBe(true);
		expect(c?.entries.filter((e) => !e.required).length, "earliest optional dropped, later kept while it fits").toBe(1);
	});

	it("a required set over the hard cap VOIDS the turn before commit — no durable stop, draft voided", async () => {
		const huge = "x".repeat(3 * 1024 * 1024);
		const events = await collect(
			stopWith({ scope: RUN_SCOPE, entries: [{ kind: "anthropic.content_block", required: true, data: huge }] }),
			RUN_SCOPE,
		);
		expect(events.some((e) => e.type === "stop"), "the stop never persisted").toBe(false);
		const terminal = events.find((e) => e.type === "terminal") as { outcome: { kind: string; error?: { code: string; retryable: boolean } } };
		expect(terminal.outcome.kind).toBe("error");
		expect(terminal.outcome.error?.code).toBe("invalid_request");
		expect(terminal.outcome.error?.retryable).toBe(false);
		expect(events.some((e) => e.type === "model_output_abandoned"), "the draft is voided (F4b)").toBe(true);
		expect(JSON.stringify(projectMessages(events))).not.toContain("answer");
	});
});

describe("MG-1 — the projection attaches the committed envelope", () => {
	it("the flushed assistant message carries its stop's continuation", async () => {
		const events = await collect(
			stopWith({ scope: RUN_SCOPE, entries: [{ kind: "anthropic.content_block", required: true, data: "blob" }] }),
			RUN_SCOPE,
		);
		const assistant = projectMessages(events).find((m) => m.role === "assistant") as { continuation?: Continuation };
		expect(assistant?.continuation?.scope).toEqual(RUN_SCOPE);
		expect(assistant?.continuation?.entries[0]?.data).toBe("blob");
	});

	it("a no-continuation stop projects exactly the pre-A5 message — the field is absent, not null", async () => {
		const plain: Adapter = {
			stream: async function* () {
				yield { seq: 0, type: "text_delta", text: "answer" } as never;
				yield { seq: 0, type: "stop", reason: "end_turn" } as never;
			},
		};
		const events = await collect(plain, RUN_SCOPE);
		const assistant = projectMessages(events).find((m) => m.role === "assistant")!;
		expect("continuation" in assistant).toBe(false);
	});
});
