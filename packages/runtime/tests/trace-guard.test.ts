/**
 * E1 (1.2.0) — slice 3, the request tracer unit gate.
 *
 * Per-call settle semantics: the record lands with the correct outcome
 * (ok / provider_error / aborted), the provider-raw usage mapping
 * (openai-compat subtractive, anthropic raw — never normalized), the
 * TTFT, the tool names, and the retryAttempt/requestIndex bookkeeping.
 * The tracer never breaks the stream: events pass through byte-identical.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterEvent, StreamOptions } from "@vincemakes/kiso-core";
import { RequestTracer } from "../src/trace/guard.js";
import { TRACE_SCHEMA_VERSION } from "../src/trace/record.js";

const HEX = (c: string) => c.repeat(64);

function testTracer(provider: string, runId = "run-1") {
	const root = mkdtempSync(join(tmpdir(), "kiso-guard-"));
	const tracer = new RequestTracer({
		root,
		sessionId: "s1",
		runId,
		provider,
		model: "m",
		log: [{ seq: 1, type: "user_input", content: "hi" }],
	});
	tracer.init();
	return { tracer, root };
}

const options = (signal?: AbortSignal): StreamOptions => ({
	model: "m",
	messages: [{ role: "user", content: "hi" }],
	systemPrompt: "sys",
	...(signal !== undefined ? { signal } : {}),
});

async function* usageStream(): AsyncIterable<AdapterEvent> {
	yield { seq: 0, type: "tool_call_start", callId: "c1", name: "add" };
	yield { seq: 0, type: "usage", inputTokens: 100, outputTokens: 5, cacheRead: 80, cacheWrite: null, known: true };
	yield { seq: 0, type: "stop", reason: "end_turn" };
}

/** The first event arrives AFTER a real delay — a network-ish stream — so
 *  ttftMs is genuinely measurable (the ttft dead-field finding: the guard
 *  checked `=== null` against a 0-initialized number and NEVER measured). */
async function* slowUsageStream(): AsyncIterable<AdapterEvent> {
	await new Promise<void>((r) => setTimeout(r, 8));
	yield { seq: 0, type: "tool_call_start", callId: "c1", name: "add" };
	yield { seq: 0, type: "usage", inputTokens: 100, outputTokens: 5, cacheRead: 80, cacheWrite: null, known: true };
	yield { seq: 0, type: "stop", reason: "end_turn" };
}

const drain = async (iter: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> => {
	const out: AdapterEvent[] = [];
	for await (const ev of iter) out.push(ev);
	return out;
};

/** settle() enqueues; the ledger flush is scheduled on setImmediate.
 *  The flush wait runs even when the stream rejects (the settle still
 *  happened in the generator's finally). */
const settle = async (tracer: RequestTracer, options: StreamOptions, stream: AsyncIterable<AdapterEvent>): Promise<void> => {
	try {
		await drain(tracer.wrap(options, stream));
	} finally {
		await new Promise<void>((r) => setImmediate(r));
	}
};

describe("E1 slice 3 — the request tracer", () => {
	it("settles an ok request: outcome ok, provider-raw usage, tool names, TTFT", async () => {
		const { tracer, root } = testTracer("openai-compat");
		// the slow stream: the first event arrives after a real delay, so
		// ttftMs MUST be measured — the dead-field finding's red side
		await settle(tracer, options(), slowUsageStream());
		const lines = JSON.parse(readFileSync(join(root, "traces", "s1.jsonl"), "utf8").split("\n").filter(Boolean).at(-1)!) as Record<string, unknown>;
		expect(lines.kind).toBe("request");
		expect(lines.schemaVersion).toBe(TRACE_SCHEMA_VERSION);
		expect(lines.outcome).toBe("ok");
		expect(lines.requestIndex).toBe(0);
		expect(lines.provider).toBe("openai-compat");
		// openai-compat: input is TOTAL, fresh = input − cacheRead
		expect(lines.freshInput).toBe(20);
		expect(lines.cacheRead).toBe(80);
		expect(lines.cacheWrite).toBeNull();
		expect(lines.output).toBe(5);
		expect(lines.toolCalls).toEqual(["add"]);
		expect(lines.ttftMs).toBeGreaterThan(0); // the fix: measured, not the dead 0
		expect(lines.latencyMs).toBeGreaterThanOrEqual(0);
		expect(lines.requestId).toMatch(/^[0-9a-f-]{36}$/);
		expect(lines.contextManifest).toHaveLength(3); // system + tools + current_turn
	});

	it("an empty stream records 0 — no event ever came, the \"0 = unknown\" marker", async () => {
		// the marker's real semantic: 0 is reserved for "no event ever".
		// A first event in the same tick records a small positive number
		// (the wrap machinery itself takes ~0.1ms) — honest, not 0.
		const { tracer, root } = testTracer("openai-compat");
		await settle(tracer, options(), (async function* () {})());
		const lines = JSON.parse(readFileSync(join(root, "traces", "s1.jsonl"), "utf8").split("\n").filter(Boolean).at(-1)!) as Record<string, unknown>;
		expect(lines.ttftMs).toBe(0);
	});

	it("anthropic usage is provider-raw: input_tokens is ALREADY fresh-only", async () => {
		const { tracer, root } = testTracer("anthropic");
		await settle(tracer, options(), usageStream());
		const lines = JSON.parse(readFileSync(join(root, "traces", "s1.jsonl"), "utf8").split("\n").filter(Boolean).at(-1)!) as Record<string, unknown>;
		expect(lines.freshInput).toBe(100); // NOT 100 − 80
		expect(lines.cacheRead).toBe(80);
	});

	it("a provider error settles as provider_error, and the error still propagates", async () => {
		const { tracer, root } = testTracer("openai-compat");
		const failing = (async function* () {
			throw new Error("boom");
		})();
		await expect(settle(tracer, options(), failing)).rejects.toThrow("boom");
		const lines = JSON.parse(readFileSync(join(root, "traces", "s1.jsonl"), "utf8").split("\n").filter(Boolean).at(-1)!) as Record<string, unknown>;
		expect(lines.outcome).toBe("provider_error");
	});

	it("an abort settles as aborted", async () => {
		const { tracer, root } = testTracer("openai-compat");
		const abortController = new AbortController();
		abortController.abort();
		const failing = (async function* () {
			throw new Error("user aborted");
		})();
		await expect(settle(tracer, options(abortController.signal), failing)).rejects.toThrow();
		const lines = JSON.parse(readFileSync(join(root, "traces", "s1.jsonl"), "utf8").split("\n").filter(Boolean).at(-1)!) as Record<string, unknown>;
		expect(lines.outcome).toBe("aborted");
	});

	it("retryAttempt counts prior calls with an IDENTICAL request hash (proposal §1.4)", async () => {
		const { tracer, root } = testTracer("openai-compat");
		const o = options();
		await settle(tracer, o, usageStream());
		await settle(tracer, o, usageStream());
		await settle(tracer, o, usageStream());
		const requests = readFileSync(join(root, "traces", "s1.jsonl"), "utf8").split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
			.filter((l: { kind: string }) => l.kind === "request");
		expect(requests.map((r: { retryAttempt: number }) => r.retryAttempt)).toEqual([0, 1, 2]);
		expect(requests.map((r: { requestIndex: number }) => r.requestIndex)).toEqual([0, 1, 2]);
	});

	it("events pass through byte-identical, and tool names are collected in order", async () => {
		const { tracer } = testTracer("openai-compat");
		const seen = await drain(tracer.wrap(options(), usageStream()));
		expect(seen.map((e) => JSON.stringify(e))).toEqual(
			[
				{ seq: 0, type: "tool_call_start", callId: "c1", name: "add" },
				{ seq: 0, type: "usage", inputTokens: 100, outputTokens: 5, cacheRead: 80, cacheWrite: null, known: true },
				{ seq: 0, type: "stop", reason: "end_turn" },
			].map((e) => JSON.stringify(e)),
		);
	});
});
