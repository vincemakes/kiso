/**
 * PROGRAM B2 research / seam B1 — the crash matrix. A crash is a prefix of the durable log (records are
 * written ahead and in order), so EVERY record boundary of a finished program is a reachable crash point.
 * For each one: what the runtime says is uncertain must equal what the raw log says is unfinished (an
 * independent oracle); resume is blocked exactly then; a human can rule children first and the program
 * last; the model is told what each child really did; and nothing that was confirmed ever runs again.
 * Invariants: I2 write-ahead, I3 closed states, I5 crash safety, I6 no duplicate mutation on resume.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Tool, type ToolResult } from "@vincemakes/kiso-core";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "../src/index.js";

const ok = (content: string): ToolResult => ({ content, isError: false });
const WORK = ["one", "two", "three"];

function tools(applied: string[]): Tool[] {
	return [
		defineTool({
			name: "program", description: "runs a program", parameters: { type: "object", properties: {} },
			execute: async (_i, ctx) => {
				for (const w of WORK) await ctx.invoke!("mutate", { what: w });
				await ctx.invoke!("peek", {});
				return ok("program finished");
			},
		}),
		defineTool({ name: "mutate", description: "a side effect", parameters: { type: "object", properties: { what: { type: "string" } }, required: ["what"] }, execute: async (i: { what: string }) => { applied.push(i.what); return ok(`applied ${i.what}`); } }),
		defineTool({ name: "peek", description: "a read", parameters: { type: "object", properties: {} }, execute: async () => ok("seen") }),
	] as unknown as Tool[];
}
const first = () => createFauxProvider([
	{ events: [{ type: "tool_call_end", callId: "p1", name: "program", input: {} }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "done" }, { type: "stop", reason: "end_turn" }] },
]);
const after = () => createFauxProvider([{ events: [{ type: "text_delta", text: "ok, continuing" }, { type: "stop", reason: "end_turn" }] }]);

interface Raw { type: string; callId?: string; executionId?: string; name?: string }
const parseLines = (text: string) => text.split("\n").filter(Boolean).map((l) => { const o = JSON.parse(l) as { event?: Raw } & Raw; return { line: l, ev: (o.event ?? o) as Raw }; });

describe("B2 research — crash at every record boundary of a program", () => {
	it("holds for all of them", async () => {
		const dir = mkdtempSync(join(tmpdir(), "p-matrix-full-"));
		const applied: string[] = [];
		const live = await createAgent({ model: "faux", adapter: first(), tools: tools(applied), store: new SessionStore(dir) }).session({ id: "s" });
		for await (const _ of live.run("go")) { /* drive */ }
		expect(applied).toEqual(WORK);
		const file = readdirSync(dir).find((f) => f.endsWith(".jsonl") && !f.includes("trace"))!;
		const lines = parseLines(readFileSync(join(dir, file), "utf8"));
		const interesting = lines.map((l, i) => ({ l, i })).filter(({ l }) => ["tool_execution_started", "tool_execution_succeeded", "tool_execution_failed", "tool_result", "terminal"].includes(l.ev.type));
		expect(interesting.length).toBeGreaterThanOrEqual(10); // 5 started + 5 receipts + the result
		const seen: string[] = [];

		for (const { i } of interesting) {
			const prefix = lines.slice(0, i + 1);
			// independent oracle from the raw prefix
			const started = new Map<string, { callId: string; name: string }>();
			const receipted = new Set<string>();
			const statusOf = new Map<string, string>();
			for (const { ev } of prefix) {
				if (ev.type === "tool_execution_started") started.set(ev.executionId!, { callId: ev.callId!, name: ev.name! });
				if (ev.type === "tool_execution_succeeded" || ev.type === "tool_execution_failed") { receipted.add(ev.executionId!); statusOf.set(ev.executionId!, ev.type.replace("tool_execution_", "")); }
			}
			const unfinished = [...started.entries()].filter(([id]) => !receipted.has(id)).map(([, v]) => v.callId).sort();
			const parentDone = prefix.some(({ ev }) => ev.type === "tool_result" && ev.callId === "p1");
			const label = `${prefix.at(-1)!.ev.type}@${i} (unfinished: ${unfinished.join(",") || "none"})`;
			seen.push(label);

			const cdir = mkdtempSync(join(tmpdir(), "p-matrix-"));
			mkdirSync(cdir, { recursive: true });
			writeFileSync(join(cdir, file), `${prefix.map((p) => p.line).join("\n")}\n`);
			const reapplied: string[] = [];
			const session = await createAgent({ model: "faux", adapter: after(), tools: tools(reapplied), store: new SessionStore(cdir) }).session({ id: "s" });

			// a) the runtime's uncertain set is the oracle's
			expect(session.uncertainExecutions().map((u) => u.callId).sort(), label).toEqual(unfinished);
			// b) resume is blocked exactly when something is uncertain
			let blocked = false;
			try { for await (const _ of session.resume()) { /* */ } } catch (e) { blocked = /blocked/i.test(String(e)); if (!blocked) throw e; }
			if (unfinished.length > 0) {
				expect(blocked, label).toBe(true);
				// c) children first, the program last
				const un = [...session.uncertainExecutions()].sort((a, b) => b.callId.length - a.callId.length);
				if (un.some((u) => u.callId === "p1") && un.length > 1) await expect(session.resolveUncertain(un.find((u) => u.callId === "p1")!.executionId, "abandoned"), label).rejects.toThrow(/child/i);
				for (const u of un) await session.resolveUncertain(u.executionId, "abandoned");
				expect(session.uncertainExecutions(), label).toEqual([]);
				// d) the model is told how every child that STARTED ended; unstarted ones are not mentioned
				if (un.some((u) => u.callId === "p1")) {
					const told = String((session.log.all.filter((e) => e.type === "tool_result" && (e as { callId: string }).callId === "p1").at(-1) as unknown as { content: string }).content);
					const kids = [...started.values()].filter((s) => s.callId.startsWith("p1/"));
					for (const k of kids) {
						const [exId] = [...started.entries()].find(([, v]) => v.callId === k.callId)!;
						const want = receipted.has(exId) ? statusOf.get(exId) : "abandoned";
						expect(told, `${label} ${k.callId}`).toContain(`${k.callId} ${k.name} ${want}`);
					}
					const mentioned = (told.match(/p1\/\d+ /g) ?? []).length;
					expect(mentioned, `${label} no unstarted child is mentioned`).toBe(kids.length);
				}
			} else {
				expect(blocked, label).toBe(false);
			}
			// e) nothing confirmed runs again; a program that had STARTED is never restarted from its source
			const programStarted = prefix.some(({ ev }) => ev.type === "tool_execution_started" && ev.callId === "p1");
			if (programStarted) expect(reapplied, label).toEqual([]);
			void parentDone;
		}
		console.log(`crash points checked: ${seen.length}\n${seen.join("\n")}`);
	}, 120_000);
});
