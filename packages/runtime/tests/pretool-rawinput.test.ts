/**
 * 0.44.0 (#20) — the hook payload carries the lexical evidence; the
 * approval chain never does.
 *
 * A host that acts at the pre-tool verdict (before execute) had no way to
 * read the arguments' raw text except assembling the stream by callId
 * itself — a second, callId-keyed reconstruction of a fact the kernel
 * already owns per invocation. onPreTool and onPostTool now receive the
 * same `rawInput` the tool gets as `ctx.rawInput`, fresh or recovered.
 * The approval chain never receives it: it decides on the parsed call,
 * and its input is otherwise unchanged. The first test is RED on 0.43.0;
 * the third pins that the evidence stays out of the chain.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Adapter, type AdapterEvent, type Event, type HookHost, type PolicyCall, type ToolCallPayload } from "@vincemakes/kiso-core";
import { createAgent, SessionStore, type AgentDefinition } from "../src/index.js";

const OUTCOME = new Set(["permission_requested", "permission_decided", "tool_execution_started", "tool_execution_succeeded", "tool_execution_failed", "tool_result"]);

function model(pieces: readonly string[] | null): Adapter {
	let n = 0;
	return {
		stream: async function* (): AsyncIterable<AdapterEvent> {
			n += 1;
			if (n === 1) {
				yield { seq: 0, type: "tool_call_start", callId: "c1", name: "probe" };
				for (const p of pieces ?? []) yield { seq: 0, type: "tool_call_input_delta", callId: "c1", inputJsonDelta: p };
				yield { seq: 0, type: "tool_call_end", callId: "c1", name: "probe", input: { x: 5 } };
				yield { seq: 0, type: "stop", reason: "tool_use" };
			} else {
				yield { seq: 0, type: "text_delta", text: "done" };
				yield { seq: 0, type: "stop", reason: "end_turn" };
			}
		},
	};
}
const answering: Adapter = {
	stream: async function* (): AsyncIterable<AdapterEvent> {
		yield { seq: 0, type: "text_delta", text: "done" };
		yield { seq: 0, type: "stop", reason: "end_turn" };
	},
};
const probe = defineTool({
	name: "probe",
	description: "p",
	parameters: { type: "object", properties: { x: { type: "number" } } },
	execute: async () => ({ content: "ok", isError: false }),
});

/** What the hooks and the chain were handed, per path. */
function recorder() {
	const pre: ToolCallPayload[] = [];
	const post: ToolCallPayload[] = [];
	const chain: Record<string, unknown>[] = [];
	const hooks: HookHost = {
		onPreTool: async (call) => {
			pre.push(call);
			return { action: "allow" };
		},
		onPostTool: async (call, result) => {
			post.push(call);
			return result;
		},
	};
	const gate = {
		name: "gate",
		approvals: [
			{
				decide: (call: PolicyCall) => {
					chain.push(call as unknown as Record<string, unknown>);
					return { action: "allow" as const };
				},
			},
		],
	};
	return { pre, post, chain, hooks, gate };
}

/** Fresh, then the same turn recovered from its prefix up to the stop (outcome events removed). */
async function bothPaths(pieces: readonly string[] | null, withChain: boolean) {
	const fresh = recorder();
	const dirA = mkdtempSync(join(tmpdir(), "kiso-pretool-fresh-"));
	const agentA = createAgent({ model: "faux", store: new SessionStore(dirA), tools: [probe], adapter: model(pieces), hooks: fresh.hooks, ...(withChain ? { extensions: [fresh.gate] } : {}) } as AgentDefinition);
	const sessionA = await agentA.session({ id: "s" });
	for await (const _ of sessionA.run("go")) void _;
	const logA = [...sessionA.log.all];
	await agentA.close();

	const callEnd = logA.findIndex((e) => e.type === "tool_call_end");
	const stopAt = logA.findIndex((e, i) => e.type === "stop" && i > callEnd);
	const prefix = logA.slice(0, stopAt + 1).filter((e) => !OUTCOME.has(e.type));
	const dirB = mkdtempSync(join(tmpdir(), "kiso-pretool-resume-"));
	const seed = new SessionStore(dirB);
	let seq = 0;
	for (const e of prefix) await seed.append("s", "r1", { ...e, seq: seq++ } as Event);
	await seed.closeAll();
	const recovered = recorder();
	const agentB = createAgent({ model: "faux", store: new SessionStore(dirB), tools: [probe], adapter: answering, hooks: recovered.hooks, ...(withChain ? { extensions: [recovered.gate] } : {}) } as AgentDefinition);
	const sessionB = await agentB.session({ id: "s" });
	for await (const _ of sessionB.resume()) void _;
	await agentB.close();
	return { fresh, recovered };
}

describe("0.44.0 (#20): onPreTool and onPostTool receive the invocation's rawInput, fresh or recovered", () => {
	it("no chain: onPreTool and onPostTool get the streamed text on both paths, identically", async () => {
		const { fresh, recovered } = await bothPaths(['{"x": 5.', "0}"], false);
		expect(fresh.pre).toHaveLength(1);
		expect(fresh.pre[0]!.rawInput).toBe('{"x": 5.0}');
		expect(fresh.post[0]!.rawInput).toBe('{"x": 5.0}');
		expect(recovered.pre).toHaveLength(1);
		expect(recovered.pre[0]).toEqual(fresh.pre[0]); // callId, name, input, rawInput — the same payload
		expect(recovered.post[0]).toEqual(fresh.post[0]);
	});

	it("no delta streamed: the payload carries no rawInput key on either path", async () => {
		const { fresh, recovered } = await bothPaths(null, false);
		expect("rawInput" in fresh.pre[0]!).toBe(false);
		expect("rawInput" in recovered.pre[0]!).toBe(false);
		expect("rawInput" in fresh.post[0]!).toBe(false);
	});

	it("the approval chain never receives the lexical evidence, on either path; it decides on the same parsed call", async () => {
		const { fresh, recovered } = await bothPaths(['{"x": 5.', "0}"], true);
		expect(fresh.chain).toHaveLength(1);
		expect(recovered.chain).toHaveLength(1);
		expect("rawInput" in fresh.chain[0]!).toBe(false);
		expect("rawInput" in recovered.chain[0]!).toBe(false);
		expect(recovered.chain[0]!.name).toBe(fresh.chain[0]!.name);
		expect(recovered.chain[0]!.input).toEqual(fresh.chain[0]!.input);
		// onPostTool still gets the evidence when a chain decided the call
		expect(fresh.post[0]!.rawInput).toBe('{"x": 5.0}');
		expect(recovered.post[0]!.rawInput).toBe('{"x": 5.0}');
	});
});
