/**
 * ADR-0063 M0.5 — internal historical retrieval (M0.5 spec § 4). "Done
 * when": query and seq lookups are correct over effective history. Every
 * hit must be an evidence `effectiveHistory` itself returns (no second
 * interpreter); the other tests pin the seq span, the two modes and the
 * literal query.
 */

import { describe, expect, it } from "vitest";
import { effectiveHistory } from "../src/effective-history.js";
import { queryTerms, searchHistory } from "../src/history-search.js";
import { abandoned, all, coding, coveredPair, duplicateCallId, log, plain, replaced, vetoed } from "./fixtures/history-logs.js";

const contents = (r: { hits: readonly { content: string }[] }) => r.hits.map((h) => h.content);

describe("M0.5 historical retrieval", () => {
	it.each(Object.entries(all))("no second interpreter: every hit is effective history's own evidence (%s)", (_name, events) => {
		for (const mode of ["effective", "audit"] as const) {
			const evidence = effectiveHistory(events, { audit: mode === "audit" });
			const reachable = mode === "audit" ? evidence : evidence.filter((e) => e.structuralStatus === "effective");
			for (const e of reachable) expect(searchHistory(events, { seq: e.seq, mode, limit: 1e9 }).hits).toContainEqual(e);
			const maxSeq = Math.max(...events.map((ev) => (ev as { seq?: number }).seq ?? -1));
			for (let seq = 0; seq <= maxSeq; seq += 1) {
				for (const hit of searchHistory(events, { seq, mode }).hits) expect(reachable).toContainEqual(hit);
			}
		}
	});

	it("seq: the event's own evidence, or the text block whose span holds it; never a neighbour", () => {
		expect(contents(searchHistory(plain, { seq: 1 }))).toEqual(["hi there"]);
		expect(contents(searchHistory(plain, { seq: 2 }))).toEqual(["hi there"]);
		expect(contents(searchHistory(plain, { seq: 3 }))).toEqual([]);
		expect(contents(searchHistory(plain, { seq: 4 }))).toEqual(["bye"]);
		expect(contents(searchHistory(coding, { seq: 11 }))).toEqual([]);
	});

	it("covered evidence is found, with coveredBy the live checkpoint's seq", () => {
		const [hit] = searchHistory(coveredPair, { seq: 4 }).hits;
		expect(hit).toMatchObject({ kind: "tool", content: "tests passed", provenance: { coveredBy: 11 } });
		expect(searchHistory(coding, { query: "resolveHistory" }).hits.every((h) => h.provenance.coveredBy === 11)).toBe(true);
	});

	it("effective mode: what the model saw; audit mode: every status", () => {
		expect(contents(searchHistory(replaced, { query: "rewritten" }))).toEqual(["rewritten by the hook"]);
		expect(searchHistory(replaced, { query: "typed by the person" }).total).toBe(0);
		expect(searchHistory(replaced, { seq: 0, mode: "audit" }).hits.map((h) => h.structuralStatus)).toEqual(["replaced", "effective"]);
		expect(searchHistory(abandoned, { query: "draft" }).total).toBe(0);
		expect(searchHistory(abandoned, { query: "draft", mode: "audit" }).hits.map((h) => h.structuralStatus)).toEqual(["abandoned"]);
		expect(searchHistory(vetoed, { seq: 0 }).total).toBe(0);
		expect(searchHistory(vetoed, { seq: 0, mode: "audit" }).hits.map((h) => h.structuralStatus)).toEqual(["replaced", "vetoed"]);
		expect(searchHistory(duplicateCallId, { seq: 8 }).total).toBe(0);
		expect(searchHistory(duplicateCallId, { seq: 8, mode: "audit" }).hits.map((h) => h.structuralStatus)).toEqual(["orphaned"]);
	});

	it("query: a path, a symbol and a tool's name by their own characters", () => {
		expect(searchHistory(coding, { query: "packages/core/src/kernel/project.ts" }).hits.map((h) => h.seq)).toEqual([2, 0]);
		expect(searchHistory(coding, { query: "resolveHistory" }).hits.map((h) => h.seq)).toEqual([5, 4]);
		expect(searchHistory(coding, { query: "read_file" }).hits.map((h) => [h.seq, h.kind])).toEqual([[4, "tool"], [2, "assistant"]]);
	});

	it("query: case-insensitive, every term, a quoted phrase whole, no pattern syntax", () => {
		expect(contents(searchHistory(coding, { query: "tests" }))).toEqual(["tests are green (no .* in any name)", "Now run the TESTS"]);
		expect(contents(searchHistory(plain, { query: '"hi there"' }))).toEqual(["hi there"]);
		expect(searchHistory(plain, { query: '"there hi"' }).total).toBe(0);
		expect(searchHistory(plain, { query: "hi bye" }).total).toBe(0);
		expect(contents(searchHistory(coding, { query: ".*" }))).toEqual(["tests are green (no .* in any name)"]);
		expect(contents(searchHistory(coding, { query: "tie", seq: 6 }))).toEqual(["The tie is in resolveHistory: the later summary wins."]);
		expect(queryTerms('  a "b  c" "" d ')).toEqual(["a", "b  c", "d"]);
	});

	it("query: a quote that never closes is a literal character, on purpose", () => {
		// JSON tool input carries quotes; a stray one must stay searchable, not vanish.
		expect(queryTerms('"foo bar')).toEqual(['"foo', "bar"]);
		expect(searchHistory(coding, { query: '"path"' }).hits.map((h) => h.seq)).toEqual([2]);
		expect(searchHistory(coding, { query: '{"path":"packages/core' }).hits.map((h) => h.seq)).toEqual([2]);
	});

	it("limit: a positive integer, or refused", () => {
		for (const limit of [0, -1, 1.5, Number.NaN]) expect(() => searchHistory(coding, { query: "e", limit })).toThrow(RangeError);
		expect(searchHistory(coding, { query: "e", limit: 1 }).hits).toHaveLength(1);
	});

	it("the tool label of a legacy result whose callId was reused: the latest declaration before it (a label; status unchanged)", () => {
		const reused = log([
			{ seq: 0, type: "user_input", content: "go" },
			{ seq: 1, type: "tool_call_start", callId: "c1", name: "read_file" },
			{ seq: 2, type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a" } },
			{ seq: 3, type: "stop", reason: "tool_use" },
			{ seq: 4, type: "tool_result", callId: "c1", content: "A", isError: false },
			{ seq: 5, type: "tool_call_start", callId: "c1", name: "shell" },
			{ seq: 6, type: "tool_call_end", callId: "c1", name: "shell", input: { command: "ls" } },
			{ seq: 7, type: "stop", reason: "tool_use" },
			{ seq: 8, type: "tool_result", callId: "c1", content: "B", isError: false },
		]);
		const results = effectiveHistory(reused).filter((e) => e.kind === "tool");
		expect(results.map((e) => [e.content, e.provenance.tool, e.structuralStatus])).toEqual([
			["A", "read_file", "effective"],
			["B", "shell", "effective"],
		]);
	});

	it("nothing asked, nothing returned; newest first; limit caps hits, total counts all", () => {
		expect(searchHistory(coding, {})).toEqual({ hits: [], total: 0 });
		expect(searchHistory(coding, { query: '   ""  ' })).toEqual({ hits: [], total: 0 });
		const r = searchHistory(coding, { query: "e", limit: 2 });
		expect(r.hits.map((h) => h.seq)).toEqual([9, 8]);
		expect(r.total).toBe(searchHistory(coding, { query: "e", limit: 1e9 }).hits.length);
		expect(r.total).toBeGreaterThan(2);
	});
});
