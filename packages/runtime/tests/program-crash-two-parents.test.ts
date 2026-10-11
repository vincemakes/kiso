/**
 * Joint AF-5 + AF-1a, crash side: TWO shared parents run together, each with two shared children that overlap, so the log interleaves their
 * records. A crash is a prefix of the durable log: at every record boundary the runtime's uncertain set equals what the raw log says is
 * unfinished, resume is blocked exactly then, each parent is ruled after its OWN children, and the model is told the true end of each child
 * of that parent only (never the other parent's). Nothing confirmed runs again.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Tool, type ToolResult } from "@vincemakes/kiso-core";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "../src/index.js";

const ok = (c: string): ToolResult => ({ content: c, isError: false });
const SHARED = { concurrency: "shared" } as const;
function tools(applied: string[]): Tool[] {
	const prog = (name: string, tag: string) => defineTool({ name, description: name, parameters: { type: "object", properties: {} }, effects: SHARED, execute: async (_i, ctx) => { await Promise.all([ctx.invoke!("mutate", { what: `${tag}1` }), ctx.invoke!("mutate", { what: `${tag}2` })]); return ok(`${tag} done`); } });
	return [
		prog("pa", "a"), prog("pb", "b"),
		defineTool({ name: "mutate", description: "m", parameters: { type: "object", properties: { what: { type: "string" } }, required: ["what"] }, effects: SHARED, execute: async (i: { what: string }) => { await new Promise((r) => setTimeout(r, 8)); applied.push(i.what); return ok(`applied ${i.what}`); } }),
	] as unknown as Tool[];
}
const first = () => createFauxProvider([
	{ events: [{ type: "tool_call_end", callId: "a", name: "pa", input: {} }, { type: "tool_call_end", callId: "b", name: "pb", input: {} }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "done" }, { type: "stop", reason: "end_turn" }] },
]);
const after = () => createFauxProvider([{ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] }]);
interface Raw { type: string; callId?: string; executionId?: string; name?: string }
const parse = (t: string) => t.split("\n").filter(Boolean).map((l) => { const o = JSON.parse(l) as { event?: Raw } & Raw; return { line: l, ev: (o.event ?? o) as Raw }; });

describe("crash matrix, two interleaved shared parents", () => {
	it("every record boundary", async () => {
		const dir = mkdtempSync(join(tmpdir(), "two-full-")); const applied: string[] = [];
		const live = await createAgent({ model: "faux", adapter: first(), tools: tools(applied), store: new SessionStore(dir) }).session({ id: "s" });
		for await (const _ of live.run("go")) { /* */ }
		expect(applied.sort()).toEqual(["a1", "a2", "b1", "b2"]);
		const file = readdirSync(dir).find((f) => f.endsWith(".jsonl") && !f.includes("trace"))!;
		const lines = parse(readFileSync(join(dir, file), "utf8"));
		const pts = lines.map((l, i) => ({ l, i })).filter(({ l }) => ["tool_execution_started", "tool_execution_succeeded", "tool_execution_failed", "tool_result", "terminal"].includes(l.ev.type));
		// the log really is interleaved: some child of one parent starts before the other parent's receipt
		const startsA = lines.findIndex(({ ev }) => ev.type === "tool_execution_started" && ev.callId === "a/1"), startsB = lines.findIndex(({ ev }) => ev.type === "tool_execution_started" && ev.callId === "b/1");
		const recA = lines.findIndex(({ ev }) => ev.type === "tool_execution_succeeded" && ev.callId === "a");
		expect(startsB).toBeLessThan(recA); expect(startsA).toBeLessThan(startsB + 3);
		let checked = 0;
		for (const { i } of pts) {
			const prefix = lines.slice(0, i + 1);
			const started = new Map<string, { callId: string; name: string }>(), receipted = new Map<string, string>();
			for (const { ev } of prefix) { if (ev.type === "tool_execution_started") started.set(ev.executionId!, { callId: ev.callId!, name: ev.name! }); if (ev.type === "tool_execution_succeeded" || ev.type === "tool_execution_failed") receipted.set(ev.executionId!, ev.type.replace("tool_execution_", "")); }
			const unfinished = [...started.entries()].filter(([id]) => !receipted.has(id)).map(([, v]) => v.callId).sort();
			// AF-5 on the durable record: no parent has a receipt while one of its own children is unfinished
			for (const p of ["a", "b"]) { const pe = [...started.entries()].find(([, v]) => v.callId === p)?.[0]; if (pe && receipted.has(pe)) expect(unfinished.filter((c) => c.startsWith(`${p}/`)), `parent ${p} receipted with an unfinished child`).toEqual([]); }
			const label = `${prefix.at(-1)!.ev.type}@${i} (unfinished: ${unfinished.join(",") || "none"})`;
			const cdir = mkdtempSync(join(tmpdir(), "two-")); mkdirSync(cdir, { recursive: true });
			writeFileSync(join(cdir, file), `${prefix.map((p) => p.line).join("\n")}\n`);
			const reapplied: string[] = [];
			const session = await createAgent({ model: "faux", adapter: after(), tools: tools(reapplied), store: new SessionStore(cdir) }).session({ id: "s" });
			expect(session.uncertainExecutions().map((u) => u.callId).sort(), label).toEqual(unfinished);
			let blocked = false;
			try { for await (const _ of session.resume()) { /* */ } } catch (e) { if (/blocked/i.test(String(e))) blocked = true; else throw e; }
			if (unfinished.length > 0) {
				expect(blocked, label).toBe(true);
				for (const u of [...session.uncertainExecutions()].sort((x, y) => y.callId.length - x.callId.length)) await session.resolveUncertain(u.executionId, "abandoned");
				expect(session.uncertainExecutions(), label).toEqual([]);
				for (const p of ["a", "b"]) {
					const pe = [...started.entries()].find(([, v]) => v.callId === p); if (!pe || receipted.has(pe[0])) continue; // a parent that was unfinished got a verdict: check its note
					const told = String((session.log.all.filter((e) => e.type === "tool_result" && (e as { callId: string }).callId === p).at(-1) as unknown as { content: string }).content);
					const other = p === "a" ? "b/" : "a/";
					expect(told, `${label}: parent ${p} must not name the other parent's children`).not.toContain(other);
					for (const [id, v] of started.entries()) if (v.callId.startsWith(`${p}/`)) expect(told, `${label} ${v.callId}`).toContain(`${v.callId} ${v.name} ${receipted.get(id) ?? "abandoned"}`);
				}
			} else expect(blocked, label).toBe(false);
			if ([...started.values()].some((v) => v.callId === "a" || v.callId === "b")) expect(reapplied.filter((x) => x), label).toEqual([]);
			checked += 1;
		}
		console.log(`crash points checked (two interleaved parents): ${checked}`);
		expect(checked).toBeGreaterThanOrEqual(14);
	}, 120_000);
});
