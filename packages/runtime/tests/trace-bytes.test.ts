/**
 * E1 (1.2.0) — slice 3, the I6 bytes gate (work-order §6: zero behavior
 * change — the trace changes NO model-visible byte).
 *
 * Two full runs of the same script, one with the request tracer wired in
 * (it always is, once run.ts lands the guard), one without: the adapter's
 * stream options (messages, system prompt, tools) and the emitted event
 * stream must be byte-identical call-for-call. Plus the ledger-side
 * acceptance: the sidecar exists in traces/, every line validates, and
 * the run ends with a run_end marker.
 *
 * "without the trace" is not a real configuration — the gate is
 * structural: the tracer lives at the adapter boundary and forwards
 * every event untouched. What the test actually pins is that the
 * presence of the ledger machinery changes nothing the model sees.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { validateTraceLine } from "../src/trace/record.js";

const TOOL = defineTool({
	name: "add",
	description: "add two numbers",
	parameters: {
		type: "object",
		properties: { a: { type: "number" }, b: { type: "number" } },
		required: ["a", "b"],
	} as const,
	execute: async () => ({ content: "five", isError: false }),
});

const SCRIPT: FauxScript = [
	{
		events: [
			{ type: "text_delta", text: "computing" },
			{ type: "tool_call_start", callId: "c1", name: "add" },
			{ type: "tool_call_end", callId: "c1", name: "add", input: { a: 2, b: 3 } },
			{ type: "stop", reason: "tool_use" },
		],
	},
	{ events: [{ type: "text_delta", text: "five" }, { type: "stop", reason: "end_turn" }] },
];

interface CallSnapshot {
	model: string;
	systemPrompt: string | undefined;
	messages: string;
	tools: string;
}

/** Run the script once, capturing every adapter call and emitted event. */
async function runScript(): Promise<{ calls: CallSnapshot[]; events: string[] }> {
	const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-bytes-")));
	const base = createFauxProvider(SCRIPT);
	const snapshot: { calls: CallSnapshot[]; events: string[] } = { calls: [], events: [] };
	const agent = createAgent({
		model: "faux",
		store,
		tools: [TOOL],
		adapter: {
			stream: (options) => {
				snapshot.calls.push({
					model: options.model,
					systemPrompt: options.systemPrompt,
					messages: JSON.stringify(options.messages),
					tools: JSON.stringify(options.tools ?? []),
				});
					return base.stream(options);
			},
		},
	});
	const session = await agent.session({ id: "s1" });
	for await (const ev of session.run("compute 2+3")) {
		snapshot.events.push(JSON.stringify(ev));
	}
	return snapshot;
}

describe("E1 slice 3 — the I6 bytes gate (zero model-visible change)", () => {
	it("the trace machinery changes no model-visible byte: two runs, identical call-for-call", async () => {
		// The tracer is wired INSIDE run.ts — the same path every run
		// takes. Two identical runs must produce byte-identical adapter
		// inputs and byte-identical event streams.
		const a = await runScript();
		const b = await runScript();
		expect(a.calls).toHaveLength(2); // two model turns
		expect(JSON.stringify(a.calls)).toBe(JSON.stringify(b.calls));
		expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
	});

	it("the ledger lands in traces/ with validating lines and a run_end marker", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-bytes-")));
		const agent = createAgent({
			model: "faux",
			store,
			tools: [TOOL],
			adapter: createFauxProvider(SCRIPT),
		});
		const session = await agent.session({ id: "tracey" });
		for await (const ev of session.run("compute 2+3")) void ev;
		const ledgerPath = join(store.root, "traces", "tracey.jsonl");
		const lines = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
		expect(lines.length).toBeGreaterThanOrEqual(4); // header + 2 requests + run_end
		for (const line of lines) {
			expect(validateTraceLine(JSON.parse(line))).toBe(true);
		}
		const kinds = lines.map((l) => JSON.parse(l).kind as string);
		expect(kinds[0]).toBe("header");
		expect(kinds.at(-1)).toBe("run_end");
		const requests = lines.map((l) => JSON.parse(l)).filter((l: { kind: string }) => l.kind === "request");
		expect(requests.map((r: { retryAttempt: number }) => r.retryAttempt)).toEqual([0, 0]);
		expect(requests.map((r: { outcome: string }) => r.outcome)).toEqual(["ok", "ok"]);
		// no phantom session: the store lists exactly the session
		expect(store.list().map((m) => m.id)).toEqual(["tracey"]);
	});
});
