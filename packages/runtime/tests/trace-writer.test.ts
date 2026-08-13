/**
 * E1 (1.2.0) — slice 2, the trace writer (proposal §1.2 + §6).
 *
 * The ledger arc: init writes the header; enqueued request lines land in
 * order on the next flush (off the hot path); finishRun lands the run_end
 * synchronously; a killed run (no run_end) is marked crash on the next
 * init, exactly once; a terminated ledger is never re-marked. The
 * soft-fail law: a broken ledger dir costs exactly ONE stderr line and
 * the writer never throws into the caller.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	TRACE_SCHEMA_VERSION,
	validateTraceLine,
	type HeaderLine,
	type RunEndLine,
	type TraceRecord,
} from "../src/trace/record.js";
import { TraceWriter } from "../src/trace/writer.js";

const HEX = (c: string) => c.repeat(64);

function requestRecord(runId: string, requestIndex: number): TraceRecord {
	return {
		schemaVersion: TRACE_SCHEMA_VERSION,
		kind: "request",
		requestId: `req-${runId}-${requestIndex}`,
		runId,
		requestIndex,
		retryAttempt: 0,
		provider: "faux",
		model: "faux",
		adapterVersion: "test",
		systemPromptHash: HEX("a"),
		toolSchemaHash: HEX("b"),
		contextHash: HEX("c"),
		contextManifest: [],
		segmentHashes: [],
		stablePrefixFingerprint: HEX("d"),
		freshInput: 10,
		cacheRead: 0,
		cacheWrite: null,
		output: 5,
		// E2 — the canonical block formalizes the quartet (the validator
		// pins the equality); cost at table v1, the "faux" route falling
		// back to the total-convention entry
		canonical: {
			input: 10,
			cacheRead: 0,
			cacheWrite: null,
			output: 5,
			reasoning: null,
			costUsd: 8.2e-6,
			pricingTableVersion: 1,
		},
		latencyMs: 1,
		ttftMs: 1,
		toolCalls: [],
		outcome: "ok",
		ts: 1_753_400_000_000,
	};
}

const ledgerLines = (root: string, sessionId: string): string[] =>
	readFileSync(join(root, "traces", `${sessionId}.jsonl`), "utf8").split("\n").filter(Boolean);

const nextImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("E1 slice 2 — the trace writer", () => {
	const dirs: string[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
	});
	const tempRoot = () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-trace-"));
		dirs.push(dir);
		return dir;
	};

	it("init writes a validating header", () => {
		const root = tempRoot();
		const writer = new TraceWriter({ root, sessionId: "s1" });
		writer.init();
		const lines = ledgerLines(root, "s1");
		expect(lines).toHaveLength(1);
		const header = JSON.parse(lines[0]!) as HeaderLine;
		expect(validateTraceLine(header)).toBe(true);
		expect(header.kind).toBe("header");
		expect(header.sessionId).toBe("s1");
		expect(header.kisoVersion).not.toBe("?");
	});

	it("enqueued request lines land in order on the next flush, off the hot path", async () => {
		const root = tempRoot();
		const writer = new TraceWriter({ root, sessionId: "s1" });
		writer.init();
		writer.enqueue(requestRecord("run-1", 0));
		writer.enqueue(requestRecord("run-1", 1));
		await nextImmediate();
		await nextImmediate(); // the flush itself is scheduled, not inline
		const lines = ledgerLines(root, "s1");
		expect(lines).toHaveLength(3); // header + 2 requests
		for (const line of lines) expect(validateTraceLine(JSON.parse(line))).toBe(true);
		expect(JSON.parse(lines[1]!).requestIndex).toBe(0);
		expect(JSON.parse(lines[2]!).requestIndex).toBe(1);
	});

	it("finishRun lands the run_end synchronously with any pending requests", () => {
		const root = tempRoot();
		const writer = new TraceWriter({ root, sessionId: "s1" });
		writer.init();
		writer.enqueue(requestRecord("run-1", 3));
		writer.finishRun("run-1", 3);
		// no setImmediate awaited: the run_end must already be on disk
		const lines = ledgerLines(root, "s1");
		const end = JSON.parse(lines.at(-1)!) as RunEndLine;
		expect(validateTraceLine(end)).toBe(true);
		expect(end.kind).toBe("run_end");
		expect(end.runId).toBe("run-1");
		expect(end.lastRequestIndex).toBe(3);
	});

	it("a killed run (no run_end) is marked crash on the next init — exactly once", async () => {
		const root = tempRoot();
		const first = new TraceWriter({ root, sessionId: "s1" });
		first.init();
		first.enqueue(requestRecord("run-1", 0));
		await nextImmediate();
		await nextImmediate();
		// the run is killed: no finishRun
		const second = new TraceWriter({ root, sessionId: "s1" });
		second.init();
		const lines = ledgerLines(root, "s1");
		const crash = JSON.parse(lines.at(-1)!) as { kind: string };
		expect(crash.kind).toBe("crash");
		expect(validateTraceLine(JSON.parse(lines.at(-1)!))).toBe(true);
		// a third init must NOT re-mark
		const third = new TraceWriter({ root, sessionId: "s1" });
		third.init();
		const after = ledgerLines(root, "s1");
		expect(after.filter((l) => JSON.parse(l).kind === "crash")).toHaveLength(1);
	});

	it("a terminated ledger is never re-marked", () => {
		const root = tempRoot();
		const first = new TraceWriter({ root, sessionId: "s1" });
		first.init();
		first.finishRun("run-1", 0);
		const second = new TraceWriter({ root, sessionId: "s1" });
		second.init();
		expect(ledgerLines(root, "s1")).toHaveLength(2); // header + run_end, no crash
	});

	it("soft-fail law: a broken ledger dir costs exactly one stderr line and the session runs on", () => {
		const root = tempRoot();
		// a FILE occupies the traces path — mkdir must fail
		writeFileSync(join(root, "traces"), "not a dir");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const writer = new TraceWriter({ root, sessionId: "s1" });
		expect(() => writer.init()).not.toThrow();
		expect(() => writer.enqueue(requestRecord("run-1", 0))).not.toThrow();
		expect(() => writer.finishRun("run-1", 0)).not.toThrow();
		expect(() => writer.enqueue(requestRecord("run-1", 1))).not.toThrow();
		expect(errorSpy).toHaveBeenCalledTimes(1); // ONE stderr line, then silence
		expect(errorSpy.mock.calls[0]?.[0]).toMatch(/trace writer degraded/);
	});

	it("a writer whose ledger dir is unwritable still leaves no partial file", () => {
		const root = tempRoot();
		writeFileSync(join(root, "traces"), "not a dir");
		const writer = new TraceWriter({ root, sessionId: "s1" });
		writer.init();
		expect(existsSync(join(root, "traces", "s1.jsonl"))).toBe(false);
	});
});
