/**
 * E1 (W21/R3 + the 2026-08-09 corrective action) — the composed approval
 * chain, where it now lives: composeApprovalChain (the runtime's
 * composition, moved out of the kernel) feeding the kernel's gate.
 * deny > allow > ask — any deny wins (the FIRST denial's reason), a
 * LATER allow beats an EARLIER ask (the allow-only dont-ask-again
 * extension must override a mode tier's ask), an ask with no later
 * allow reaches the HUMAN, an all-abstain asks (ADR-0042 — no opinion
 * is never a silent allow), a throwing policy counts as ask, and the
 * attribution rides permission_decided durably.
 *
 * The corrective action's four conditions are pinned by name: ① a
 * mode-tier deny is never overridden by anything; ② a safe-defaults
 * deny is never overridden by anything; ③ a later allow silences ONLY
 * an earlier ask (never a deny, never reordered); ④ an ask with no
 * later allow still reaches the human.
 */

import { describe, expect, it, vi } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool, EventLog, loop, type Event, type PolicyVerdict } from "@vincemakes/kiso-core";
import { ToolRegistry } from "@vincemakes/kiso-core";
import { composeApprovalChain } from "../src/compose.js";

type PolicyInput = { name: string; input: unknown };
type FakeExt = { name: string; approvals: { decide: (call: PolicyInput) => PolicyVerdict }[] };

const allowAll = (): PolicyVerdict => ({ action: "allow" });
const askAll = (): PolicyVerdict => ({ action: "ask" });
const abstainAll = (): PolicyVerdict => ({ action: "abstain" });
const denyShell = (reason: string) => (call: PolicyInput): PolicyVerdict =>
	call.name === "shell" ? { action: "deny", reason } : { action: "allow" };

function makeRegistry(): ToolRegistry {
	const registry = new ToolRegistry();
	registry.register(
		defineTool({
			name: "read_file",
			description: "r",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: "ok", isError: false }),
		}),
	);
	registry.register(
		defineTool({
			name: "shell",
			description: "s",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: "ran", isError: false }),
		}),
	);
	return registry;
}

function scriptedCall(name: string, callId: string, input: Record<string, unknown>): FauxScript {
	return [{ events: [{ type: "tool_call_end", callId, name, input }, { type: "stop", reason: "tool_use" }] }];
}

const decided = (log: EventLog): (Event & { type: "permission_decided" })[] =>
	log.all.filter((e): e is Event & { type: "permission_decided" } => e.type === "permission_decided");
const resultOf = (log: EventLog): (Event & { type: "tool_result" }) | undefined =>
	log.all.find((e): e is Event & { type: "tool_result" } => e.type === "tool_result");

/** Run one scripted call through the loop with the composed chain. */
async function runCall(
	call: { name: string; callId: string; input: Record<string, unknown> },
	extensions: FakeExt[],
	opts: {
		resolveApproval?: (id: string) => Promise<{ action: "allow" } | { action: "deny"; reason: string }>;
	} = {},
): Promise<EventLog> {
	const log = new EventLog();
	log.append({ type: "user_input", content: "go" });
	const chain = composeApprovalChain(extensions);
	for await (const _ev of loop({
		adapter: createFauxProvider(scriptedCall(call.name, call.callId, call.input)),
		model: "faux",
		registry: makeRegistry(),
		log,
		...(chain !== undefined ? { approvalPolicy: chain } : {}),
		...(opts.resolveApproval !== undefined ? { resolveApproval: opts.resolveApproval } : {}),
	})) {
		// drain
	}
	return log;
}

describe("the corrective action: the four sanctioned conditions", () => {
	it("① a mode-tier deny is never overridden by anything — a later allow does not un-deny", async () => {
		const log = await runCall(
			{ name: "shell", callId: "s1", input: { command: "git reset --hard" } },
			[
				{ name: "mode:plan", approvals: [{ decide: denyShell("no git reset in plan mode") }] },
				{ name: "my-ext", approvals: [{ decide: allowAll }] },
			],
		);
		const ds = decided(log);
		expect(ds).toHaveLength(1);
		expect(ds[0]).toMatchObject({ decision: "denied", reason: "no git reset in plan mode", decidedBy: "mode:plan" });
		expect(log.all.some((e) => e.type === "permission_requested")).toBe(false);
		expect(resultOf(log)).toMatchObject({ isError: true });
	});

	it("② a safe-defaults deny is never overridden by anything — a mode-tier allow does not un-deny", async () => {
		const log = await runCall(
			{ name: "shell", callId: "s1", input: { command: "rm -rf /" } },
			[
				{ name: "mode:bypass", approvals: [{ decide: allowAll }] },
				{ name: "safe-defaults", approvals: [{ decide: denyShell("rm -rf is never allowed") }] },
			],
		);
		const ds = decided(log);
		expect(ds).toHaveLength(1);
		expect(ds[0]).toMatchObject({ decision: "denied", reason: "rm -rf is never allowed", decidedBy: "safe-defaults" });
		expect(log.all.some((e) => e.type === "permission_requested")).toBe(false);
	});

	it("③ a later allow silences ONLY an earlier ask — never a deny, never reordered", async () => {
		// ask → allow: the allow decides (the dont-ask-again extension lives).
		const askFirst = await runCall(
			{ name: "read_file", callId: "r1", input: { path: "a.ts" } },
			[
				{ name: "mode:default", approvals: [{ decide: askAll }] },
				{ name: "allow-only", approvals: [{ decide: allowAll }] },
			],
			{ resolveApproval: async () => ({ action: "allow" }) },
		);
		const ds1 = decided(askFirst);
		expect(ds1).toHaveLength(1);
		expect(ds1[0]).toMatchObject({ decision: "approved", decidedBy: "allow-only" });
		expect(askFirst.all.some((e) => e.type === "permission_requested")).toBe(false); // never paused

		// allow → ask: NOT reordered — the later ask never un-allows.
		const allowFirst = await runCall(
			{ name: "read_file", callId: "r1", input: { path: "a.ts" } },
			[
				{ name: "allow-only", approvals: [{ decide: allowAll }] },
				{ name: "mode:default", approvals: [{ decide: askAll }] },
			],
			{ resolveApproval: async () => ({ action: "allow" }) },
		);
		const ds2 = decided(allowFirst);
		expect(ds2).toHaveLength(1);
		expect(ds2[0]!).toMatchObject({ decision: "approved", decidedBy: "allow-only" });

		// deny → allow: a later allow NEVER silences a deny.
		const denyFirst = await runCall(
			{ name: "shell", callId: "s1", input: { command: "git reset --hard" } },
			[
				{ name: "mode:plan", approvals: [{ decide: denyShell("no") }] },
				{ name: "allow-only", approvals: [{ decide: allowAll }] },
			],
		);
		const ds3 = decided(denyFirst);
		expect(ds3[0]!).toMatchObject({ decision: "denied", decidedBy: "mode:plan" });

		// ask → deny: the deny outranks the ask.
		const askThenDeny = await runCall(
			{ name: "shell", callId: "s1", input: { command: "git reset --hard" } },
			[
				{ name: "ask-all", approvals: [{ decide: askAll }] },
				{ name: "safe-defaults", approvals: [{ decide: denyShell("never destructive git") }] },
			],
		);
		const ds4 = decided(askThenDeny);
		expect(ds4[0]!).toMatchObject({ decision: "denied", decidedBy: "safe-defaults" });
	});

	it("④ an ask with no later allow still reaches the human — the request pauses and the human decides", async () => {
		const log = await runCall(
			{ name: "shell", callId: "s1", input: { command: "curl example.com" } },
			[{ name: "mode:default", approvals: [{ decide: askAll }] }],
			{ resolveApproval: async () => ({ action: "allow" }) },
		);
		expect(log.all.some((e) => e.type === "permission_requested")).toBe(true); // the human flow ran
		const ds = decided(log);
		expect(ds).toHaveLength(1);
		expect(ds[0]!.decision).toBe("approved");
		expect(ds[0]!.decidedBy).toBeUndefined(); // the HUMAN decided — no speaker to record
		expect(resultOf(log)?.content).toBe("ran"); // the approved call executed
	});
});

describe("E1: the chain composes deny > allow > ask", () => {
	it("deny outranks ask and allow — the FIRST denial's reason, decidedBy recorded", async () => {
		const log = await runCall(
			{ name: "shell", callId: "s1", input: { command: "git reset --hard" } },
			[
				{ name: "allow-all", approvals: [{ decide: allowAll }] },
				{ name: "danger-guard", approvals: [{ decide: denyShell("no destructive git") }] },
				{ name: "ask-all", approvals: [{ decide: askAll }] },
			],
		);
		const ds = decided(log);
		expect(ds).toHaveLength(1);
		expect(ds[0]).toMatchObject({ decision: "denied", reason: "no destructive git", decidedBy: "danger-guard" });
		expect(log.all.some((e) => e.type === "permission_requested")).toBe(false);
		expect(resultOf(log)?.content).toContain("[Permission denied] no destructive git");
	});

	it("all allow — auto-approved with the FIRST speaker's name, never a human pause", async () => {
		const log = await runCall(
			{ name: "read_file", callId: "r1", input: { path: "a.ts" } },
			[
				{ name: "reader", approvals: [{ decide: allowAll }] },
				{ name: "writer", approvals: [{ decide: allowAll }] },
			],
		);
		expect(log.all.some((e) => e.type === "permission_requested")).toBe(false);
		const ds = decided(log);
		expect(ds).toHaveLength(1);
		expect(ds[0]).toMatchObject({ decision: "approved", decidedBy: "reader" });
		expect(log.all.some((e) => e.type === "tool_result" && e.content === "ok")).toBe(true);
	});

	it("a policy that throws counts as ask — a LATER allow still overrides it (W21/R3)", async () => {
		// PH-1a (finding PH-F17): the degradation must SPEAK — a
		// permanently-throwing policy used to manifest only as "why is it
		// asking me about everything?", with zero observability on a
		// security-critical path. One stderr line names the extension and
		// the error; the fail-safe direction (degrade to ask) is unchanged.
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const log = await runCall(
				{ name: "read_file", callId: "r1", input: { path: "a.ts" } },
				[
					{
						name: "broken",
						approvals: [
							{
								decide: () => {
									throw new Error("policy bug");
								},
							},
						],
					},
					{ name: "allow-all", approvals: [{ decide: allowAll }] },
				],
			);
			// The thrown ask is an ask — but the LATER allow beats it (R3);
			// the run executes, never pausing for the human.
			expect(log.all.some((e) => e.type === "permission_requested")).toBe(false);
			expect(decided(log)[0]).toMatchObject({ decision: "approved", decidedBy: "allow-all" });
			expect(resultOf(log)?.content).toBe("ok");
			const spoke = errSpy.mock.calls.map((c) => String(c[0]));
			expect(spoke.some((line) => line.includes("broken") && line.includes("policy bug") && line.includes("ask"))).toBe(true);
		} finally {
			errSpy.mockRestore();
		}
	});

	it("abstain does not weaken a deny — the deny still wins and records its own name", async () => {
		const log = await runCall(
			{ name: "shell", callId: "s1", input: { command: "git reset --hard" } },
			[
				{ name: "mode:bypass", approvals: [{ decide: allowAll }] },
				{ name: "safe-test", approvals: [{ decide: abstainAll }] },
				{ name: "danger-guard", approvals: [{ decide: denyShell("no destructive git") }] },
			],
		);
		const ds = decided(log);
		expect(ds).toHaveLength(1);
		expect(ds[0]!).toMatchObject({ decision: "denied", reason: "no destructive git", decidedBy: "danger-guard" });
	});

	it("abstain + a user allow → auto-approved with decidedBy = the SPEAKER, never the abstainer", async () => {
		const log = await runCall(
			{ name: "read_file", callId: "r1", input: { path: "a.ts" } },
			[
				{ name: "mode:default", approvals: [{ decide: abstainAll }] }, // the non-speaker sits FIRST
				{ name: "allow-mcp", approvals: [{ decide: allowAll }] },
			],
		);
		const ds = decided(log);
		expect(ds).toHaveLength(1);
		expect(ds[0]!).toMatchObject({ decision: "approved", decidedBy: "allow-mcp" }); // the FIRST SPEAKER, not the chain head
		expect(log.all.some((e) => e.type === "permission_requested")).toBe(false);
	});

	it("an all-abstain chain (ADR-0042) ASKS the human — never a silent auto-approve", async () => {
		const log = await runCall(
			{ name: "shell", callId: "s1", input: { command: "curl example.com" } },
			[
				{ name: "silent-1", approvals: [{ decide: abstainAll }] },
				{ name: "silent-2", approvals: [{ decide: abstainAll }] },
			],
			{ resolveApproval: async () => ({ action: "allow" }) },
		);
		// The all-abstain chain fell to the human flow — the external tool
		// meets the human, exactly the ADR-0042 finding's fix.
		expect(log.all.some((e) => e.type === "permission_requested")).toBe(true);
		const ds = decided(log);
		expect(ds).toHaveLength(1);
		expect(ds[0]!.decision).toBe("approved");
		expect(ds[0]!.decidedBy).toBeUndefined(); // the HUMAN decided — no speaker to record
		expect(resultOf(log)?.content).toBe("ran");
	});

	it("an all-abstain chain with NO approval channel → the honest denial, never a silent run", async () => {
		const log = await runCall(
			{ name: "shell", callId: "s1", input: { command: "curl example.com" } },
			[
				{ name: "silent-1", approvals: [{ decide: abstainAll }] },
				{ name: "silent-2", approvals: [{ decide: abstainAll }] },
			],
		);
		expect(log.all.some((e) => e.type === "permission_requested")).toBe(false);
		expect(resultOf(log)).toMatchObject({ isError: true });
		expect(resultOf(log)?.content).toContain("no approval flow is configured");
		expect(log.all.some((e) => e.type === "tool_execution_started")).toBe(false);
	});

	it("no policies → composeApprovalChain returns undefined — the plain flow, never an all-abstain ask", async () => {
		expect(composeApprovalChain([])).toBeUndefined();
		expect(composeApprovalChain([{ name: "no-approvals", hooks: {} }] as never)).toBeUndefined();
	});
});
