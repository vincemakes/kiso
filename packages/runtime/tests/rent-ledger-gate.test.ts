/**
 * E3 (0.2.1) — the rent ledger gate (R7, the star).
 *
 * buildRentLedger is the single source of the per-surface rent lines:
 * system:base (the composed base prompt), system:ext:<name> (extension
 * appends, load order), tool:<name> (the exact ToolSpec projection the
 * adapters send), envelope (the R5 skeleton). The star assertion: the
 * script's prediction (scripts/request-surface.mjs, the default bench
 * composition) equals the ledger a REAL session records — the rent
 * table a release report carries is machine-proven, not transcribed.
 *
 * The gate drives the default composition exactly as the CLI builds it:
 * the built-in system prompt, the coding tools, and the three default
 * built-in extensions (mcp / skills / subagent; the task extension is
 * opt-in since E5) against a bare home (no skills, no MCP servers) —
 * the bench session shape.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "../src/index.js";
import { buildRentLedger } from "../src/trace/rent.js";
import { TRACE_SCHEMA_VERSION, validateTraceLine, validateTraceRecord } from "../src/trace/record.js";
import { defaultCompositionParts, predictDefaultRentLedger, predictSideQueryRentLedger } from "../../../scripts/request-surface.mjs";

const MODEL = "m";
const est = (n: number) => Math.ceil(n / 4);

describe("E3 — the rent ledger: buildRentLedger unit semantics", () => {
	it("R9: an absent surface is an absent line — a bare request pays only the envelope", () => {
		const lines = buildRentLedger({ model: MODEL });
		expect(lines).toEqual([{ surface: "envelope", chars: 38, estTokens: 10 }]);
	});

	it("system:base and the extension appends land in order", () => {
		const lines = buildRentLedger({
			model: MODEL,
			base: "hello",
			appends: [
				{ name: "task", text: "plan guidance" },
				{ name: "skills", text: "idx" },
			],
		});
		expect(lines.slice(0, 3)).toEqual([
			{ surface: "system:base", chars: 5, estTokens: 2 },
			{ surface: "system:ext:task", chars: 13, estTokens: 4 },
			{ surface: "system:ext:skills", chars: 3, estTokens: 1 },
		]);
	});

	it("tool lines are the exact ToolSpec projection the adapters send", () => {
		const tools = [{ name: "add", description: "add two numbers", inputSchema: { type: "object", properties: {} } }];
		const spec = JSON.stringify(tools[0]!);
		const lines = buildRentLedger({ model: MODEL, tools });
		expect(lines[0]).toEqual({ surface: "tool:add", chars: spec.length, estTokens: est(spec.length) });
	});

	it("the envelope is the R5 skeleton — a model-string function, never the payloads", () => {
		const lines = buildRentLedger({ model: "deepseek-chat" });
		expect(lines[0]!.chars).toBe(JSON.stringify({ model: "deepseek-chat", messages: [], tools: [] }).length);
		// base + one append = three lines; the envelope is the LAST (index 2)
		expect(buildRentLedger({ model: MODEL, base: "x", appends: [{ name: "a", text: "b" }] })[2]).toEqual({
			surface: "envelope",
			chars: 38,
			estTokens: 10,
		});
	});
});

describe("E3 — R7 star: the script's prediction equals a real session's recorded ledger", () => {
	it("the default bench composition records exactly what request-surface.mjs predicts", async () => {
		// the script predicts against a bare home — no skills, no MCP servers
		const home = mkdtempSync(join(tmpdir(), "kiso-rent-home-"));
		const parts = await defaultCompositionParts({ home });
		const predicted = await predictDefaultRentLedger(MODEL, { home });

		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-rent-")));
		const agent = createAgent({
			model: MODEL,
			store,
			systemPrompt: parts.base,
			tools: parts.tools,
			extensions: parts.extensions,
			adapter: createFauxProvider([{ events: [{ type: "text_delta", text: "hi" }, { type: "stop", reason: "end_turn" }] }]),
		});
		const session = await agent.session({ id: "tracey" });
		for await (const ev of session.run("hi")) void ev;
		agent.close();

		const ledgerPath = join(store.root, "traces", "tracey.jsonl");
		const lines = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
		for (const line of lines) expect(validateTraceLine(JSON.parse(line))).toBe(true);
		const request = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.kind === "request");
		expect(request).toBeDefined();
		expect(request!.schemaVersion).toBe(TRACE_SCHEMA_VERSION);
		expect(validateTraceRecord(request)).toBe(true);
		// the headline artifact: predicted == recorded, line for line
		expect(request!.rent).toEqual(predicted);
		// sanity: the predicted ledger is not empty and covers every class
		expect(predicted.some((l) => l.surface === "system:base")).toBe(true);
		// E5: the task extension left the default — against a bare home the
		// composition carries NO extension appends (its only former append
		// was the task guidance, system:ext:task 394c). The empty class is
		// the new composition's shape, asserted on purpose.
		expect(predicted.some((l) => l.surface.startsWith("system:ext:"))).toBe(false);
		expect(predicted.some((l) => l.surface.startsWith("tool:"))).toBe(true);
		expect(predicted.at(-1)!.surface).toBe("envelope");
	});
});

/**
 * TUI2-R3v2 ③ — the SECOND declared arm (the safer-options seam,
 * adjudicated 2026-08-18).
 *
 * The gate's rule is prediction == recording per request, and a side
 * query is a request. It gets its own arm because its composition is its
 * own: it sends its small system prompt and nothing else — no extension
 * appends, and no tools at all. Predicting it with the DEFAULT arm would
 * overstate its rent by the entire tool table, which is precisely the
 * error that would make an on-demand feature look ambient.
 */
describe("TUI2-R3v2 ③ — the side-query arm: prediction equals a real side query's ledger", () => {
	it("a real session.sideQuery records exactly what predictSideQueryRentLedger predicts", async () => {
		const SIDE_PROMPT = "propose 2-3 safer alternative commands with one-line reasons, JSON";
		const home = mkdtempSync(join(tmpdir(), "kiso-sq-home-"));
		const parts = await defaultCompositionParts({ home });

		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-sq-rent-")));
		const agent = createAgent({
			model: MODEL,
			store,
			systemPrompt: parts.base,
			tools: parts.tools,
			extensions: parts.extensions,
			adapter: createFauxProvider([{ events: [{ type: "text_delta", text: "[]" }, { type: "stop", reason: "end_turn" }] }]),
		});
		const session = await agent.session({ id: "sidey" });
		await session.sideQuery({ purpose: "safer-options", systemPrompt: SIDE_PROMPT, prompt: "the pending call is: rm -rf build" });
		agent.close();

		const lines = readFileSync(join(store.root, "traces", "sidey.jsonl"), "utf8").split("\n").filter(Boolean);
		for (const line of lines) expect(validateTraceLine(JSON.parse(line))).toBe(true);
		const request = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.kind === "request");
		expect(request).toBeDefined();
		expect(validateTraceRecord(request)).toBe(true);
		expect(request!.purpose).toBe("safer-options");

		// the headline artifact for this arm: predicted == recorded
		expect(request!.rent).toEqual(predictSideQueryRentLedger(MODEL, SIDE_PROMPT));
		// …and the arm's whole point — the surfaces a side query does NOT pay
		const surfaces = (request!.rent as { surface: string }[]).map((l) => l.surface);
		expect(surfaces).toEqual(["system:base", "envelope"]);
		expect(surfaces.some((s) => s.startsWith("tool:"))).toBe(false);
		expect(surfaces.some((s) => s.startsWith("system:ext:"))).toBe(false);
	});
});
