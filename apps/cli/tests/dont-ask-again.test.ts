/**
 * W21/R3 — the don't-ask-again extension and the moat order, through the
 * REAL runtime (createAgent + the faux provider + the real mode chain):
 *   - the MODE moat: a mode:<tier> DENY beats the rule's allow
 *     (deny > allow > ask — the R3 order), decidedBy "mode:plan";
 *   - the ALLOW override: a later allow beats an EARLIER ask — the
 *     allow-only extension is not structurally dead (the old ask-wins
 *     chain would have asked the human anyway), decidedBy
 *     "dont-ask-again";
 *   - the SAFE-DEFAULTS moat: the destructive-command deny beats the
 *     rule's allow, decidedBy "safe-defaults";
 *   - No+words: approve(false, words) — the words become the
 *     tool_result, the run continues to a completed terminal;
 *   - bare No + abort: approve(false) THEN run.abort() — the CLI's
 *     bare-No mapping verbatim — the run ends aborted.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool, type Event } from "@vincemakes/kiso-core";
import { createAgent, SessionStore, type KisoExtension } from "@vincemakes/kiso-runtime";
import { modeExtensions, setMode, type Mode } from "../src/mode.js";

/** The R3 shape — the exact module the don't-ask-again writer generates
 *  (ALLOW-ONLY: never emits deny or ask). */
function dontAskAgain(rules: readonly string[]): KisoExtension {
	return {
		name: "dont-ask-again",
		approvals: [
			{
				decide: (call) => (rules.includes(call.name) ? { action: "allow" } : { action: "abstain" }),
			},
		],
	};
}

/** A faithful replica of the INSTALLED safe-defaults extension (the real
 *  file lives at ~/.kiso/extensions/safe-defaults.mjs — outside the
 *  repo; the test asserts the CHAIN semantics, so the deny moat is
 *  replicated verbatim). */
const safeDefaults: KisoExtension = {
	name: "safe-defaults",
	approvals: [
		{
			decide: (call) => {
				if (call.name === "read_file" || call.name === "list_dir" || call.name === "search_text") {
					return { action: "allow" };
				}
				if (
					call.name === "shell" &&
					/\bgit\s+(stash|reset|checkout\s+--)|rm\s+-rf/.test(String(call.input.command ?? ""))
				) {
					return { action: "deny", reason: "destructive command — refused by the safe-defaults policy" };
				}
				return { action: "ask" };
			},
		},
	],
};

const EDIT_SCRIPT: FauxScript = [
	{ events: [{ type: "tool_call_end", callId: "c1", name: "edit_file", input: { path: "x.ts" } }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "stop", reason: "end_turn" }] },
];

const SHELL_SCRIPT: FauxScript = [
	{
		events: [{ type: "tool_call_end", callId: "c1", name: "shell", input: { command: "git reset --hard HEAD" } }, { type: "stop", reason: "tool_use" }],
	},
	{ events: [{ type: "stop", reason: "end_turn" }] },
];

/** The R3 chain order: mode:<tier> → dont-ask-again → safe-defaults. */
function chain(tier: Mode, rules: readonly string[]): readonly KisoExtension[] {
	setMode(tier);
	return [...modeExtensions(), dontAskAgain(rules), safeDefaults];
}

function chainAgent(script: FauxScript, extra: readonly KisoExtension[]) {
	const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-moat-")));
	const agent = createAgent({
		model: "faux",
		store,
		tools: [
			defineTool<{ path: string }>({
				name: "edit_file",
				description: "Edit",
				parameters: { type: "object", properties: { path: { type: "string" } } },
				execute: async () => ({ content: "edited", isError: false }),
			}),
			defineTool<{ command: string }>({
				name: "shell",
				description: "Shell",
				parameters: { type: "object", properties: { command: { type: "string" } } },
				execute: async () => ({ content: "done", isError: false }),
			}),
		],
		adapter: createFauxProvider(script),
		extensions: extra,
	});
	return { store, agent };
}

describe("W21/R3: the don't-ask-again moats", () => {
	it("the MODE moat — mode:plan's deny beats the rule's allow (deny > allow > ask)", async () => {
		const { agent } = chainAgent(EDIT_SCRIPT, chain("plan", ["edit_file"]));
		const session = await agent.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.run("go")) events.push(ev);
		const decided = events.find((e) => e.type === "permission_decided");
		expect(decided).toMatchObject({ decision: "denied", decidedBy: "mode:plan" });
		expect(events.some((e) => e.type === "permission_requested")).toBe(false);
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(false);
		expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: true, errorKind: "precondition" });
	});

	it("the ALLOW override — a later allow beats an earlier ask; decidedBy dont-ask-again", async () => {
		const { agent } = chainAgent(EDIT_SCRIPT, chain("default", ["edit_file"]));
		const session = await agent.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.run("go")) events.push(ev);
		const decided = events.find((e) => e.type === "permission_decided");
		expect(decided).toMatchObject({ decision: "approved", decidedBy: "dont-ask-again" });
		expect(events.some((e) => e.type === "permission_requested")).toBe(false);
		expect(events.some((e) => e.type === "tool_execution_succeeded")).toBe(true);
	});

	it("the SAFE-DEFAULTS moat — the destructive-command deny beats the rule's allow", async () => {
		const { agent } = chainAgent(SHELL_SCRIPT, chain("default", ["shell"]));
		const session = await agent.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.run("go")) events.push(ev);
		const decided = events.find((e) => e.type === "permission_decided");
		expect(decided).toMatchObject({ decision: "denied", decidedBy: "safe-defaults" });
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(false);
		const result = events.find((e) => e.type === "tool_result");
		expect(result).toMatchObject({ isError: true });
		expect((result as { content: string }).content).toContain("destructive command");
	});

	it("an unruled tool still ASKS — the rule never speaks for it (no rule, no allow)", async () => {
		const { agent } = chainAgent(EDIT_SCRIPT, chain("default", []));
		const session = await agent.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.run("go")) {
			events.push(ev);
			if (ev.type === "permission_requested") await session.approve(ev.decisionId, true);
		}
		expect(events.some((e) => e.type === "permission_requested")).toBe(true);
	});
});

describe("W21: the CLI verdict mapping through the runtime", () => {
	it("No+words — approve(false, words): the words become the tool_result, the run continues", async () => {
		const { agent } = chainAgent(EDIT_SCRIPT, chain("default", []));
		const session = await agent.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.run("go")) {
			events.push(ev);
			if (ev.type === "permission_requested") await session.approve(ev.decisionId, false, "no — keep it simple");
		}
		const result = events.find((e) => e.type === "tool_result");
		expect(result).toMatchObject({ isError: true });
		expect((result as { content: string }).content).toContain("keep it simple");
		// the run CONTINUES — the denial is a result, not an abort.
		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal).toMatchObject({ outcome: { kind: "completed" } });
	});

	it("bare No + abort — approve(false) FIRST, then run.abort(): the run ends aborted", async () => {
		const { agent } = chainAgent(EDIT_SCRIPT, chain("default", []));
		const session = await agent.session({ id: "s" });
		const events: Event[] = [];
		const run = session.run("go");
		for await (const ev of run) {
			events.push(ev);
			if (ev.type === "permission_requested") {
				await session.approve(ev.decisionId, false);
				run.abort();
			}
		}
		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal).toMatchObject({ outcome: { kind: "aborted", by: "user" } });
	});
});
