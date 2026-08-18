/**
 * TUI2-R3v2 slice ③ — the side query (seam B, adjudicated 2026-08-18).
 *
 * A side query is ONE model request a session can make that is not part
 * of any run: the human pressed a button and wants an answer now, while
 * a run sits paused at an approval. Three properties make it shippable
 * rather than a hole in the accounting:
 *
 *  1. IT IS VISIBLE. It rides the same traceGuard every run request
 *     rides, so it lands in the trace ledger with its own request line.
 *     A request the ledger cannot see is rent nobody can audit, and this
 *     round's whole argument for the feature is that its rent is
 *     bounded and on-demand — which is only checkable if it is counted.
 *  2. IT IS DISTINGUISHABLE. A fresh runId plus a `purpose` marker, so
 *     a trace consumer can separate side queries from run requests
 *     without heuristics.
 *  3. IT IS EPHEMERAL. It writes NO durable events — no session-log
 *     lines, no receipts, nothing. Its only durable consequence is what
 *     the human does with the answer, and that lands through the
 *     existing amend channel like any other human verdict.
 *
 * The zero-ambient-rent assertion is the last test here and it is the
 * one the round is accountable for: a session that never asks pays
 * nothing.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { defineTool } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { TRACE_SCHEMA_VERSION, validateTraceLine, validateTraceRecord } from "../src/trace/record.js";
import { buildRentLedger } from "../src/trace/rent.js";

const MODEL = "m";

/** One faux turn of plain text. */
const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });

/** The session carries a REAL tool on purpose: the rent arm below proves
 *  a side query does not inherit the session's tool surface, and a
 *  tool-less session could not tell the difference. */
const ADD = defineTool({
	name: "add",
	description: "add two numbers",
	inputSchema: { type: "object", properties: {} },
	run: () => ({ content: "3" }),
});

async function fixture(script: unknown[]) {
	const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-sq-")));
	const agent = createAgent({
		model: MODEL,
		store,
		systemPrompt: "you are a test",
		tools: [ADD],
		adapter: createFauxProvider(script as never),
	});
	const session = await agent.session({ id: "sq" });
	return { store, agent, session };
}

/** Every trace line the session's sidecar holds. */
function traceLines(store: SessionStore, id = "sq"): Record<string, unknown>[] {
	const path = join(store.root, "traces", `${id}.jsonl`);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	return raw
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

const SYS = "propose safer alternatives";
const PROMPT = "the pending call is: rm -rf build";

describe("TUI2-R3v2 ③ — the side query is TRACE-VISIBLE", () => {
	it("records a request line of its own, marked with its purpose", async () => {
		const { store, agent, session } = await fixture([say("alternatives here")]);
		const answer = await session.sideQuery({ purpose: "safer-options", systemPrompt: SYS, prompt: PROMPT });
		agent.close();

		expect(answer).toBe("alternatives here");
		const requests = traceLines(store).filter((l) => l.kind === "request");
		expect(requests, "the side query must land ONE request line").toHaveLength(1);
		const r = requests[0]!;
		expect(validateTraceLine(r)).toBe(true);
		expect(validateTraceRecord(r)).toBe(true);
		expect(r.schemaVersion).toBe(TRACE_SCHEMA_VERSION);
		expect(r.purpose, "the marker a consumer separates side queries by").toBe("safer-options");
		expect(r.outcome).toBe("ok");
	});

	it("carries a FRESH runId — never the paused run's", async () => {
		const { store, agent, session } = await fixture([say("turn one"), say("alternatives")]);
		for await (const ev of session.run("hello")) void ev;
		await session.sideQuery({ purpose: "safer-options", systemPrompt: SYS, prompt: PROMPT });
		agent.close();

		const requests = traceLines(store).filter((l) => l.kind === "request");
		expect(requests).toHaveLength(2);
		const [runReq, sideReq] = requests as [Record<string, unknown>, Record<string, unknown>];
		expect(sideReq.runId).not.toBe(runReq.runId);
		expect(runReq.purpose, "an ordinary run request carries no purpose").toBeUndefined();
		expect(sideReq.purpose).toBe("safer-options");
	});

	it("an ordinary run is UNCHANGED — no purpose, and the old records still validate", async () => {
		const { store, agent, session } = await fixture([say("just a turn")]);
		for await (const ev of session.run("hello")) void ev;
		agent.close();
		const requests = traceLines(store).filter((l) => l.kind === "request");
		expect(requests).toHaveLength(1);
		expect(validateTraceRecord(requests[0])).toBe(true);
		expect("purpose" in requests[0]!).toBe(false);
	});
});

describe("TUI2-R3v2 ③ — the side query is EPHEMERAL", () => {
	it("writes NO durable events — the session log is byte-for-byte what it was", async () => {
		const { agent, session } = await fixture([say("turn one"), say("alternatives")]);
		for await (const ev of session.run("hello")) void ev;
		const before = JSON.stringify(session.log.all);
		await session.sideQuery({ purpose: "safer-options", systemPrompt: SYS, prompt: PROMPT });
		expect(JSON.stringify(session.log.all), "a side query must not touch the durable log").toBe(before);
		agent.close();
	});

	it("does not count as a run — the one-run-at-a-time guard is untouched", async () => {
		const { agent, session } = await fixture([say("alternatives"), say("turn")]);
		// a side query in flight must not block the next run from starting
		await session.sideQuery({ purpose: "safer-options", systemPrompt: SYS, prompt: PROMPT });
		for await (const ev of session.run("hello")) void ev;
		agent.close();
	});

	it("aborts on its signal — esc cancels the ask, and it settles as aborted", async () => {
		const { store, agent, session } = await fixture([{ events: [{ type: "delay", ms: 5000 }, { type: "stop", reason: "end_turn" }] }]);
		const ctrl = new AbortController();
		const pending = session.sideQuery({ purpose: "safer-options", systemPrompt: SYS, prompt: PROMPT, signal: ctrl.signal });
		ctrl.abort();
		await expect(pending).rejects.toThrow();
		agent.close();
		const requests = traceLines(store).filter((l) => l.kind === "request");
		expect(requests[0]?.outcome).toBe("aborted");
	});
});

describe("TUI2-R3v2 ③ — the side query's DECLARED rent arm", () => {
	it("pays its OWN composition: its small prompt + the envelope, and no tools", async () => {
		const { store, agent, session } = await fixture([say("alternatives")]);
		await session.sideQuery({ purpose: "safer-options", systemPrompt: SYS, prompt: PROMPT });
		agent.close();

		const request = traceLines(store).find((l) => l.kind === "request")!;
		// the declared arm: base = the side query's OWN system prompt (never
		// the session's), no extension appends, NO tool lines (a side query
		// sends no tools — it cannot call anything), and the envelope.
		expect(request.rent).toEqual(buildRentLedger({ model: MODEL, base: SYS }));
		const surfaces = (request.rent as { surface: string }[]).map((l) => l.surface);
		expect(surfaces).toEqual(["system:base", "envelope"]);
		expect(surfaces.some((s) => s.startsWith("tool:")), "a side query offers no tools").toBe(false);
		expect(surfaces.some((s) => s.startsWith("system:ext:")), "and carries no extension appends").toBe(false);
	});
});

describe("TUI2-R3v2 ③ — ZERO AMBIENT RENT", () => {
	it("a session that never asks makes no side query — nothing to pay for", async () => {
		const { store, agent, session } = await fixture([say("one"), say("two"), say("three")]);
		for await (const ev of session.run("hello")) void ev;
		for await (const ev of session.run("again")) void ev;
		agent.close();

		const requests = traceLines(store).filter((l) => l.kind === "request");
		expect(requests.length, "two turns, two requests — and not one more").toBe(2);
		expect(requests.filter((r) => r.purpose !== undefined), "zero side queries in a session that never pressed the button").toHaveLength(0);
	});
});
