/**
 * AUDIT: crash at every record boundary of a program whose children were decided by a POLICY (the scope policy): each child then leaves a
 * `permission_decided` of its own, with a callId `<parent>/<n>` that no tool_call_end in the log carries. Recovery must neither choke on
 * those records nor misbind them; the ledger invariants of the plain matrix must still hold at every point.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type KisoExtension } from "@vincemakes/kiso-core";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { createProgramExtension, hideTools } from "../src/index.js";

const asks: KisoExtension = { name: "mode", approvals: [{ decide: (c: { name: string }) => (c.name === "secret" ? { action: "ask" as const } : { action: "abstain" as const }) }] } as never;
const domain = (applied: string[]): KisoExtension => ({ name: "d", tools: [defineTool({ name: "secret", description: "s", parameters: { type: "object", properties: { n: { type: "number" } } }, execute: async (i: { n: number }) => { applied.push(`s${i.n}`); return { content: "{}", isError: false }; } })] as never });
const CODE = `await tools.secret({ n: 1 }); await tools.secret({ n: 2 }); await tools.secret({ n: 3 }); return "done";`;
const SCOPE = [{ tool: "secret", maxCalls: 3 }];
const first = () => createFauxProvider([{ events: [{ type: "tool_call_end", callId: "p1", name: "program", input: { code: CODE, scope: SCOPE } }, { type: "stop", reason: "tool_use" }] }, { events: [{ type: "text_delta", text: "done" }, { type: "stop", reason: "end_turn" }] }]);
const after = () => createFauxProvider([{ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] }]);
interface Raw { type: string; callId?: string; executionId?: string; name?: string; decidedBy?: string }
const parse = (t: string) => t.split("\n").filter(Boolean).map((l) => { const o = JSON.parse(l) as { event?: Raw } & Raw; return { line: l, ev: (o.event ?? o) as Raw }; });

describe("crash matrix with policy-decided children", () => {
	it("every record boundary, including the decision records of the children", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cs-full-")); const applied: string[] = [];
		const live = await createAgent({ model: "faux", adapter: first(), tools: [], extensions: [createProgramExtension({}, { scope: true }), hideTools(domain(applied)), asks], store: new SessionStore(dir) }).session({ id: "s" });
		for await (const ev of live.run("go")) if (ev.type === "permission_requested") await live.approve((ev as unknown as { decisionId: string }).decisionId, true);
		expect(applied).toEqual(["s1", "s2", "s3"]);
		const file = readdirSync(dir).find((f) => f.endsWith(".jsonl") && !f.includes("trace"))!;
		const lines = parse(readFileSync(join(dir, file), "utf8"));
		expect(lines.filter(({ ev }) => ev.type === "permission_decided" && ev.callId?.startsWith("p1/")).length).toBe(3); // the children DID leave decision records
		const points = lines.map((l, i) => ({ l, i })).filter(({ l }) => ["permission_requested", "permission_decided", "tool_execution_started", "tool_execution_succeeded", "tool_execution_failed", "tool_result", "terminal"].includes(l.ev.type));
		let checked = 0;
		for (const { i } of points) {
			const prefix = lines.slice(0, i + 1);
			const started = new Map<string, string>(), receipted = new Set<string>();
			for (const { ev } of prefix) { if (ev.type === "tool_execution_started") started.set(ev.executionId!, ev.callId!); if (ev.type === "tool_execution_succeeded" || ev.type === "tool_execution_failed") receipted.add(ev.executionId!); }
			const unfinished = [...started.entries()].filter(([id]) => !receipted.has(id)).map(([, c]) => c).sort();
			const label = `${prefix.at(-1)!.ev.type}${prefix.at(-1)!.ev.callId ? " " + prefix.at(-1)!.ev.callId : ""}@${i} (unfinished: ${unfinished.join(",") || "none"})`;
			const cdir = mkdtempSync(join(tmpdir(), "cs-")); mkdirSync(cdir, { recursive: true });
			writeFileSync(join(cdir, file), `${prefix.map((p) => p.line).join("\n")}\n`);
			const reapplied: string[] = [];
			const session = await createAgent({ model: "faux", adapter: after(), tools: [], extensions: [createProgramExtension({}, { scope: true }), hideTools(domain(reapplied)), asks], store: new SessionStore(cdir) }).session({ id: "s" });
			expect(session.uncertainExecutions().map((u) => u.callId).sort(), label).toEqual(unfinished);
			let blocked = false, other: unknown;
			try { for await (const ev of session.resume()) if (ev.type === "permission_requested") await session.approve((ev as unknown as { decisionId: string }).decisionId, true); } catch (e) { if (/blocked/i.test(String(e))) blocked = true; else other = e; }
			expect(other, `${label}: resume threw something that is not a block`).toBeUndefined();
			if (unfinished.length > 0) {
				expect(blocked, label).toBe(true);
				for (const u of [...session.uncertainExecutions()].sort((a, b) => b.callId.length - a.callId.length)) await session.resolveUncertain(u.executionId, "abandoned");
				expect(session.uncertainExecutions(), label).toEqual([]);
			}
			// nothing the log says was confirmed may run again after a restart
			const confirmed = [...started.entries()].filter(([id]) => receipted.has(id)).map(([, c]) => c).filter((c) => c.startsWith("p1/"));
			for (const c of confirmed) expect(reapplied.length, `${label}: confirmed child ${c} must not re-run`).toBe(0);
			checked += 1;
		}
		console.log(`crash points checked (policy-decided children): ${checked}`);
		expect(checked).toBeGreaterThanOrEqual(14);
	}, 120_000);
});
