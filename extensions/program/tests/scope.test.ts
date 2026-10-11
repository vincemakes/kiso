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

// ── the grant must come from a verified decision, not from the model's own scope ───────────────
const allowsProgram = (): KisoExtension => ({ name: "blanket-mode", approvals: [{ decide: (c: { name: string }) => (c.name === "program" || c.name === "plan" ? { action: "allow" as const } : { action: "abstain" as const }) }] } as never);
async function runWith(input: Record<string, unknown>, extra: KisoExtension[], answer: "approve" | "deny" | "none" = "approve", front?: KisoExtension) {
	const effects: string[] = [], events: Event[] = [];
	const agent = createAgent({ model: "faux", adapter: createFauxProvider(script("program", input)), tools: [], extensions: [front ?? createProgramExtension({}, { scope: true }), hideTools(domain(effects)), ...extra], store: new SessionStore(mkdtempSync(join(tmpdir(), "scope-"))) });
	const session = await agent.session({ id: "s" });
	for await (const ev of session.run("go")) { events.push(ev); if (ev.type === "permission_requested" && answer !== "none") await session.approve((ev as unknown as { decisionId: string }).decisionId, answer === "approve"); }
	const res = String((events.filter((e) => e.type === "tool_result") as unknown as { content: string }[])[0]!.content);
	return { effects, events, res };
}
const ONE = `try { await tools.secret({ n: 1 }); return "ran"; } catch (e) { return "refused: " + e.message.slice(0, 80); }`;
describe("scope grant origin (owner's ruling: requested scope is not granted scope)", () => {
	it("a program call auto-allowed by another policy does NOT turn its own scope into a grant: the child that needs a human is still refused", async () => {
		const r = await runWith({ code: ONE, scope: [{ tool: "secret" }] }, [asksFor("secret"), allowsProgram()], "none");
		expect(r.events.some((e) => e.type === "permission_requested")).toBe(false); // nobody was asked: the blanket allow decided
		expect(r.effects).toEqual([]);
		expect(r.res).toMatch(/refused: .*needs a human decision/);
	});
	it("a human who DENIES the program call: nothing runs", async () => {
		const r = await runWith({ code: ONE, scope: [{ tool: "secret" }] }, [asksFor("secret")], "deny");
		expect(r.effects).toEqual([]);
		expect(r.events.some((e) => e.type === "tool_execution_started")).toBe(false);
	});
	it("a human who approves: the same scope IS a grant", async () => {
		const r = await runWith({ code: ONE, scope: [{ tool: "secret" }] }, [asksFor("secret")], "approve");
		expect(r.effects).toEqual(["secret:1"]);
	});
	const careless = (): KisoExtension => ({ name: "trusted-workflow", approvals: [{ decide: (c: { name: string }) => (c.name === "program" ? { action: "allow" as const } : { action: "abstain" as const }) }] } as never); // a policy a host might trust, that never looks at the scope
	it("a policy that merely ALLOWS the program call is never a grant, however trusted it is (it did not review the scope)", async () => {
		const r = await runWith({ code: ONE, scope: [{ tool: "secret" }] }, [asksFor("secret"), careless()], "none", createProgramExtension({}, { scope: true }));
		expect(r.effects).toEqual([]);
		expect(r.res).toMatch(/refused: .*needs a human decision/);
	});
	it("the host's grant() judges the ACTUAL scope: accepted scope -> grant; a broader one -> none; a throwing judge -> none; it sees the validated scope and the call input", async () => {
		const seen: unknown[] = [];
		const judge = (scope: readonly { tool: string }[], input: Record<string, unknown>) => { seen.push({ scope, input }); return scope.every((e) => e.tool === "secret"); };
		const yes = await runWith({ code: ONE, scope: [{ tool: "secret" }] }, [asksFor("secret", "other"), careless()], "none", createProgramExtension({}, { scope: { grant: judge } }));
		expect(yes.effects).toEqual(["secret:1"]);
		expect(JSON.stringify(seen[0])).toContain('"tool":"secret"');
		expect(JSON.stringify(seen[0])).toContain("code");
		const broad = await runWith({ code: ONE, scope: [{ tool: "secret" }, { tool: "other" }] }, [asksFor("secret", "other"), careless()], "none", createProgramExtension({}, { scope: { grant: judge } }));
		expect(broad.effects).toEqual([]); // the host refused to grant this scope; the in-request child falls back to its own policy (an ask, refused)
		const boom = await runWith({ code: ONE, scope: [{ tool: "secret" }] }, [asksFor("secret"), careless()], "none", createProgramExtension({}, { scope: { grant: () => { throw new Error("judge down"); } } }));
		expect(boom.effects).toEqual([]);
	});
	it("safety does not depend on event timing: with no way to observe the approval, a human-approved program is NOT granted (it fails closed; only liveness is lost)", async () => {
		const front = createProgramExtension({}, { scope: true }); delete (front as { hooks?: unknown }).hooks; // the observer is absent: the human's decision cannot be seen
		const r = await runWith({ code: ONE, scope: [{ tool: "secret" }] }, [asksFor("secret")], "approve", front);
		expect(r.effects).toEqual([]);
		expect(r.res).toMatch(/refused: .*needs a human decision/);
	});
	it("outside the REQUESTED scope is still denied even with no grant (the scope only ever limits)", async () => {
		const r = await runWith({ code: `try { await tools.other({ who: "x" }); return "ran"; } catch (e) { return "refused: " + e.message.slice(0, 120); }`, scope: [{ tool: "secret" }] }, [asksFor("other"), allowsProgram()], "none");
		expect(r.effects).toEqual([]);
		expect(r.res).toMatch(/outside the approved scope|outside the requested scope/);
	});
	it("two programs in one turn: one human-approved, one auto-allowed: no grant leaks between them", async () => {
		const effects: string[] = [], events: Event[] = [];
		const script2 = [
			{ events: [
				{ type: "tool_call_end" as const, callId: "pa", name: "program", input: { code: `await tools.secret({ n: 11 }); return "a";`, scope: [{ tool: "secret" }] } },
				{ type: "tool_call_end" as const, callId: "pb", name: "program", input: { code: `try { await tools.secret({ n: 22 }); return "b ran"; } catch (e) { return "b refused"; }`, scope: [{ tool: "secret" }] } },
				{ type: "stop" as const, reason: "tool_use" as const }] },
			{ events: [{ type: "text_delta" as const, text: "done" }, { type: "stop" as const, reason: "end_turn" as const }] },
		];
		const autoB: KisoExtension = { name: "auto-b", approvals: [{ decide: (c: { name: string; input: Record<string, unknown> }) => (c.name === "program" && String(c.input.code).includes("b ran") ? { action: "allow" as const } : { action: "abstain" as const }) }] } as never;
		const agent = createAgent({ model: "faux", adapter: createFauxProvider(script2), tools: [], extensions: [createProgramExtension({}, { scope: true }), hideTools(domain(effects)), asksFor("secret"), autoB], store: new SessionStore(mkdtempSync(join(tmpdir(), "scope-"))) });
		const session = await agent.session({ id: "s" });
		for await (const ev of session.run("go")) { events.push(ev); if (ev.type === "permission_requested") await session.approve((ev as unknown as { decisionId: string }).decisionId, true); }
		expect(effects).toEqual(["secret:11"]); // only the human-approved program's child ran
	});
});
