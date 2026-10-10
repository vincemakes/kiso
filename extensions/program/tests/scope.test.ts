/**
 * Scope-shaped approval (research prototype, extension level): the program DECLARES the tools, argument constraints and
 * call counts it may use; the human approves THAT with the program call; a child inside the scope is allowed (decidedBy the
 * scope), a child outside it is denied - never asked, never silently widened. Explicit denies still win; a program with no
 * scope behaves exactly as before (a child that needs a human is refused).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Event, type KisoExtension } from "@vincemakes/kiso-core";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { createPlanExtension, createProgramExtension, hideTools, parseScope } from "../src/index.js";

const domain = (effects: string[]): KisoExtension => ({
	name: "domain",
	tools: ["secret", "other"].map((n) => defineTool({ name: n, description: n, parameters: { type: "object", properties: { n: { type: "number" }, who: { type: "string" } } }, execute: async (i: { n?: number; who?: string }) => { effects.push(`${n}:${i.n ?? i.who ?? ""}`); return { content: "{}", isError: false }; } })) as never,
});
// "the user's default mode": both domain tools need a human
const asksFor = (...names: string[]): KisoExtension => ({ name: "mode", approvals: [{ decide: (c: { name: string }) => (names.includes(c.name) ? { action: "ask" as const } : { action: "abstain" as const }) }] } as never);
const denies = (name: string): KisoExtension => ({ name: "rules", approvals: [{ decide: (c: { name: string }) => (c.name === name ? { action: "deny" as const, reason: "rule: never" } : { action: "abstain" as const }) }] } as never);
const script = (tool: string, input: Record<string, unknown>) => [
	{ events: [{ type: "tool_call_end" as const, callId: "p1", name: tool, input }, { type: "stop" as const, reason: "tool_use" as const }] },
	{ events: [{ type: "text_delta" as const, text: "done" }, { type: "stop" as const, reason: "end_turn" as const }] },
];
async function run(tool: "program" | "plan", input: Record<string, unknown>, extra: KisoExtension[] = [asksFor("secret", "other")]) {
	const effects: string[] = [], events: Event[] = [], seen: unknown[] = [];
	const front = tool === "program" ? createProgramExtension({}, { scope: true }) : createPlanExtension({ scope: true });
	const agent = createAgent({ model: "faux", adapter: createFauxProvider(script(tool, input)), tools: [], extensions: [front, hideTools(domain(effects)), ...extra], store: new SessionStore(mkdtempSync(join(tmpdir(), "scope-"))) });
	const session = await agent.session({ id: "s" });
	for await (const ev of session.run("go")) {
		events.push(ev);
		if (ev.type === "permission_requested") { seen.push(ev); await session.approve((ev as unknown as { decisionId: string }).decisionId, true); } // the human says yes to whatever is put to them
	}
	const res = String((events.filter((e) => e.type === "tool_result") as unknown as { content: string }[])[0]!.content);
	return { effects, events, seen, res, started: events.filter((e) => e.type === "tool_execution_started").map((e) => (e as { callId: string; name: string }).callId + ":" + (e as { name: string }).name) };
}
const CODE = `const o = []; for (const [t, a] of [["secret", { n: 1 }], ["secret", { n: 2 }], ["secret", { n: 3 }], ["secret", { n: 1 }], ["other", { who: "x" }]]) { try { await tools[t](a); o.push(t + ":" + (a.n ?? a.who) + " ok"); } catch (e) { o.push(t + ":" + (a.n ?? a.who) + " DENIED: " + String(e.message).slice(0, 70)); } } return o;`;

describe("scope-shaped approval", () => {
	it("a child inside the approved scope runs without asking; outside it, or past the count, it is denied; the human saw the scope with the program call", async () => {
		const scope = [{ tool: "secret", maxCalls: 2, where: { n: [1, 2] } }];
		const r = await run("program", { code: CODE, scope });
		expect(r.effects).toEqual(["secret:1", "secret:2"]);
		expect(r.res).toContain("secret:1 ok");
		expect(r.res).toContain("secret:2 ok");
		expect(r.res).toMatch(/secret:3 DENIED: .*outside the approved scope/);
		expect(r.res).toMatch(/secret:1 DENIED: .*outside the approved scope/); // a third call exceeds maxCalls: 2 (the first n:1 already counted)
		expect(r.res).toMatch(/other:x DENIED: .*outside the approved scope/);
		expect(r.started).toEqual(["p1:program", "p1/1:secret", "p1/2:secret"]); // refused children never start
		const asked = r.seen.filter((c) => (c as { name: string }).name === "program");
		expect(asked).toHaveLength(1);
		expect((asked[0] as { input: { scope: unknown } }).input.scope).toEqual(scope); // what the human approved
		expect(r.seen.some((c) => (c as { name: string }).name === "secret")).toBe(false); // no child was put to a human
	});

	it("approval only narrows: an explicit deny rule beats the scope", async () => {
		const r = await run("program", { code: `try { await tools.secret({ n: 1 }); return "ran"; } catch (e) { return "denied: " + e.message; }`, scope: [{ tool: "secret" }] }, [asksFor("secret"), denies("secret")]);
		expect(r.effects).toEqual([]);
		expect(r.res).toMatch(/denied: .*rule: never/);
	});

	it("without a scope nothing changes: a child that needs a human is refused", async () => {
		const r = await run("program", { code: `try { await tools.secret({ n: 1 }); return "ran"; } catch (e) { return "refused: " + e.message; }` });
		expect(r.effects).toEqual([]);
		expect(r.res).toMatch(/refused: .*needs a human decision/);
	});

	it("plan: same scope rules", async () => {
		const r = await run("plan", { code: `const a = call("secret", { n: 1 }); const b = call("secret", { n: 9 }); output({ a });`, scope: [{ tool: "secret", where: { n: 1 } }] });
		expect(r.effects).toEqual(["secret:1"]);
		expect(r.res).toMatch(/failed secret .*outside the approved scope/);
	});

	it("a scope is validated: wildcards, unknown shapes and oversized scopes are refused before anything runs", async () => {
		expect(() => parseScope([{ tool: "*" }])).toThrow(/explicit tool/);
		expect(() => parseScope([{ tool: "a", maxCalls: -1 }])).toThrow(/maxCalls/);
		expect(() => parseScope([{ tool: "a", where: { n: { nested: 1 } } }])).toThrow(/where/);
		expect(() => parseScope("all")).toThrow(/array/);
		expect(() => parseScope(Array.from({ length: 60 }, (_, i) => ({ tool: `t${i}` })))).toThrow(/too many/);
		expect(parseScope(undefined)).toBeUndefined();
		const r = await run("program", { code: `return 1;`, scope: [{ tool: "*" }] });
		expect(r.res).toMatch(/explicit tool/);
		expect(r.effects).toEqual([]);
	});
});
