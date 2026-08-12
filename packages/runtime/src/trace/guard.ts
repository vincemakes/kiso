/**
 * E1 (1.2.0) — slice 3, the request tracer (the guard).
 *
 * One TraceRecord per adapter call, settled when the stream ends. The
 * guard lives AT the adapter boundary (run.ts wires
 * truncationGuard(traceGuard(tracer, adapter))): the kernel, the log,
 * and the model-visible byte stream are untouched (I6 — pinned by
 * trace-bytes.test.ts). retryAttempt counts prior calls in this run
 * with an identical contextHash — the loop re-streams the SAME messages
 * array on retry (loop.ts), so an identical hash is exactly "same
 * request, retried" (§1.4).
 *
 * Soft-fail: any failure in trace assembly (never expected — hashes and
 * the manifest cannot throw today) marks the request ABSENT rather than
 * breaking the stream; the writer's own degradation covers I/O.
 *
 * Usage is provider-raw, never normalized (E2's job): openai-compat
 * reports input TOTAL (fresh = input − cacheRead); anthropic's
 * input_tokens is ALREADY fresh-only (the trace records it as-is).
 * A request that settles with NO usage data records the quartet as
 * zeros with cacheWrite null — "0 = unknown", documented at record.ts;
 * the honest nullable quartet is a schema bump, deferred.
 */

import { randomUUID } from "node:crypto";
import type { Adapter, AdapterEvent, Event, StreamOptions } from "@vincemakes/kiso-core";
import { buildContextManifest, segmentHashes } from "./manifest.js";
import { cacheableHashes } from "./analyze.js";
import { hashContext, hashSystemPrompt, hashToolSpecs, stablePrefixFingerprint } from "./hash.js";
import { TRACE_SCHEMA_VERSION, type Outcome, type TraceRecord } from "./record.js";
import { TraceWriter } from "./writer.js";

export interface RequestTracerDeps {
	root: string;
	sessionId: string;
	runId: string;
	provider: string;
	model: string;
	/** The adapter contract's implementation version (the runtime's own),
	 *  resolved once at tracer init; null on failure (soft-fail). */
	adapterVersion?: string | null;
	/** The session log — the manifest's seqRange pointers derive from it. */
	log: readonly Event[];
}

export class RequestTracer {
	readonly #writer: TraceWriter;
	readonly #log: readonly Event[];
	readonly #provider: string;
	readonly #runId: string;
	readonly #adapterVersion: string | null;
	#requestIndex = 0;
	#contextHashCounts = new Map<string, number>();

	constructor(deps: RequestTracerDeps) {
		this.#writer = new TraceWriter({ root: deps.root, sessionId: deps.sessionId });
		this.#log = deps.log;
		this.#provider = deps.provider;
		this.#runId = deps.runId;
		this.#adapterVersion = deps.adapterVersion ?? null;
	}

	init(): void {
		this.#writer.init();
	}

	async *wrap(options: StreamOptions, upstream: AsyncIterable<AdapterEvent>): AsyncIterable<AdapterEvent> {
		const t0 = performance.now();
		let record: TraceRecord | null = null;
		try {
			record = this.#startRecord(options);
		} catch {
			record = null; // trace absent; the stream is never affected
		}

		// null until the first event; settled to 0 (unknown) only when no
		// event ever came — a stream whose first event lands in the same
		// tick records 0, the resolution limit of the "0 = unknown" marker
		let ttftMs: number | null = null;
		let inputTokens: number | null = null;
		let cacheRead: number | null = null;
		let cacheWrite: number | null = null;
		let outputTokens: number | null = null;
		let usageKnown = false;
		const toolCalls: string[] = [];
		let outcome: Outcome = "ok";

		try {
			for await (const ev of upstream) {
				// the null check must be the ONLY guard — a 0-initialized
				// number never moves (the slice-3 dead-field finding)
				if (ttftMs === null) ttftMs = performance.now() - t0;
				if (ev.type === "tool_call_start") toolCalls.push(ev.name);
				if (ev.type === "usage") {
					usageKnown = usageKnown || ev.known;
					if (ev.inputTokens !== null) inputTokens = ev.inputTokens;
					if (ev.cacheRead !== null) cacheRead = ev.cacheRead;
					if (ev.cacheWrite !== null) cacheWrite = ev.cacheWrite;
					if (ev.outputTokens !== null) outputTokens = ev.outputTokens;
				}
				yield ev;
			}
		} catch (err) {
			outcome = this.#classifyOutcome(err, options);
			throw err;
		} finally {
			if (record !== null) {
				this.#settle(record, {
					outcome,
					t0,
					ttftMs,
					toolCalls,
					inputTokens,
					cacheRead,
					cacheWrite,
					outputTokens,
					usageKnown,
				});
			}
		}
	}

	/** Clean-settle marking for the whole run. */
	finishRun(): void {
		this.#writer.finishRun(this.#runId, this.#requestIndex - 1);
	}

	#startRecord(options: StreamOptions): TraceRecord {
		const { systemPrompt, tools, messages } = options;
		const contextHash = hashContext(systemPrompt, tools, messages);
		const retryAttempt = this.#contextHashCounts.get(contextHash) ?? 0;
		this.#contextHashCounts.set(contextHash, retryAttempt + 1);
		const manifest = buildContextManifest({ log: this.#log, systemPrompt, tools, messages });
		const hashes = segmentHashes(systemPrompt, tools, messages);
		return {
			schemaVersion: TRACE_SCHEMA_VERSION,
			kind: "request",
			requestId: randomUUID(),
			runId: this.#runId,
			requestIndex: this.#requestIndex++,
			retryAttempt,
			provider: this.#provider,
			model: options.model,
			adapterVersion: this.#adapterVersion,
			systemPromptHash: hashSystemPrompt(systemPrompt),
			toolSchemaHash: hashToolSpecs(tools),
			contextHash,
			contextManifest: manifest,
			// R4b: the per-segment hash LIST rides the record (the break
			// derivation is analysis-side but needs the list, not the
			// aggregated fingerprint — slice 5's data source); the
			// fingerprint covers the CACHEABLE prefix only — the current
			// turn (freshness fresh) is never part of it (slice 4)
			segmentHashes: hashes,
			stablePrefixFingerprint: stablePrefixFingerprint(cacheableHashes(manifest, hashes)),
			freshInput: 0, // unknown until the usage event — "0 = unknown"
			cacheRead: 0,
			cacheWrite: null,
			output: 0,
			latencyMs: 0,
			ttftMs: 0,
			toolCalls: [],
			outcome: "ok",
			ts: Date.now(),
		};
	}

	#settle(
		record: TraceRecord,
		p: {
			outcome: Outcome;
			t0: number;
			ttftMs: number | null;
			toolCalls: string[];
			inputTokens: number | null;
			cacheRead: number | null;
			cacheWrite: number | null;
			outputTokens: number | null;
			usageKnown: boolean;
		},
	): void {
		record.outcome = p.outcome;
		record.latencyMs = performance.now() - p.t0;
		record.ttftMs = p.ttftMs ?? 0; // null = no event ever — the "0 = unknown" marker
		record.toolCalls = p.toolCalls;
		if (p.usageKnown) {
			record.freshInput =
				this.#provider === "anthropic"
					? p.inputTokens ?? 0
					: p.inputTokens !== null
						? Math.max(0, p.inputTokens - (p.cacheRead ?? 0))
						: 0;
			record.cacheRead = p.cacheRead ?? 0;
			record.cacheWrite = p.cacheWrite ?? null;
			record.output = p.outputTokens ?? 0;
		}
		this.#writer.enqueue(record);
	}

	#classifyOutcome(err: unknown, options: StreamOptions): Outcome {
		if (options.signal?.aborted === true) return "aborted";
		const name = err instanceof Error ? err.name : "";
		if (name === "AbortError" || name === "APIUserAbortError") return "aborted";
		return "provider_error";
	}
}

/** Wrap the adapter so every stream() call settles a trace record. */
export function traceGuard(tracer: RequestTracer, adapter: Adapter): Adapter {
	return {
		stream: (options) => tracer.wrap(options, adapter.stream(options)),
	};
}
