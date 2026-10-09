/**
 * ADR-0061 — an edit_file call persisted BEFORE the rename, resumed after it.
 *
 * The model-facing schema now refuses `search`/`replace`; a log written by
 * the previous version holds them. Recovery has two paths, and they treat
 * such a call differently — both are pinned here:
 *
 *  - APPROVED, not yet executed (the EXECUTE step, `#executeInvocation`):
 *    a durable approval authorizes the persisted call as it stands. It is
 *    not re-validated against today's schema, so the executor must still
 *    take the old names — and the durable `tool_execution_started.input`
 *    is the original input, never rewritten into the new vocabulary.
 *  - UNDECIDED (the DECIDE_PERMISSION step, 0430-F1): the call is
 *    preflighted like a fresh one, against TODAY's schema. An old-name
 *    call is refused once as invalid_input — no decision, no approval
 *    prompt, no execution. What the model does next (re-issue it in the
 *    new vocabulary, or not) is the model's; kiso guarantees only that the
 *    refusal reaches it.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Adapter, type AdapterEvent, type Event, type Tool } from "@vincemakes/kiso-core";
import { editFileTool } from "@vincemakes/kiso-tools-node";
import { createAgent, SessionStore, type AgentDefinition } from "../src/index.js";

const rev = (s: string): string => `rev:${createHash("sha256").update(Buffer.from(s)).digest("hex").slice(0, 16)}`;

/** The previous version's advertised schema — the shape a pre-rename log was written against. */
const LEGACY_SCHEMA = {
	type: "object",
	properties: {
		path: { type: "string" },
		search: { type: "string" },
		replace: { type: "string" },
		edits: { type: "array", items: { type: "object", properties: { search: { type: "string" }, replace: { type: "string" }, expectedRevision: { type: "string" } }, required: ["search", "replace"], additionalProperties: false } },
		expectedRevision: { type: "string" },
	},
	required: ["path", "expectedRevision"],
	additionalProperties: false,
};

function once(input: Record<string, unknown>): Adapter {
	let n = 0;
	return {
		stream: async function* (): AsyncIterable<AdapterEvent> {
			n += 1;
			if (n === 1) {
				yield { seq: 0, type: "tool_call_start", callId: "c1", name: "edit_file" };
				yield { seq: 0, type: "tool_call_input_delta", callId: "c1", inputJsonDelta: JSON.stringify(input) };
				yield { seq: 0, type: "tool_call_end", callId: "c1", name: "edit_file", input };
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
const gate = { name: "gate", approvals: [{ decide: () => ({ action: "allow" as const }) }] };
const EXECUTION = new Set(["tool_execution_started", "tool_execution_succeeded", "tool_execution_failed", "tool_result"]);

/** Write a pre-rename session (the previous schema, a speaking chain that
 *  approves), cut its durable log at `keep`, put the file back as it was,
 *  and resume under TODAY's edit_file. */
async function resumeAfterUpgrade(keep: (e: Event) => boolean) {
	const workspace = mkdtempSync(join(tmpdir(), "kiso-ef-rec-ws-"));
	writeFileSync(join(workspace, "f.ts"), "A\n");
	const input = { path: "f.ts", search: "A", replace: "B", expectedRevision: rev("A\n") };
	const today = editFileTool({ workspaceRoot: workspace });
	const before = { ...today, parameters: LEGACY_SCHEMA } as Tool<never>;

	const dirA = mkdtempSync(join(tmpdir(), "kiso-ef-rec-a-"));
	const storeA = new SessionStore(dirA);
	const agentA = createAgent({ model: "faux", store: storeA, tools: [before], adapter: once(input), extensions: [gate] } as unknown as AgentDefinition);
	const sA = await agentA.session({ id: "s" });
	for await (const _ of sA.run("go")) void _;
	const logA = [...sA.log.all];
	agentA.close();

	const callEnd = logA.findIndex((e) => e.type === "tool_call_end");
	const stopAt = logA.findIndex((e, i) => e.type === "stop" && i > callEnd);
	const decidedAt = logA.findIndex((e) => e.type === "permission_decided");
	const cut = Math.max(stopAt, decidedAt);
	const prefix = logA.slice(0, cut + 1).filter((e) => !EXECUTION.has(e.type) && keep(e));
	writeFileSync(join(workspace, "f.ts"), "A\n"); // the crash came before the edit landed

	const dirB = mkdtempSync(join(tmpdir(), "kiso-ef-rec-b-"));
	const seed = new SessionStore(dirB);
	let seq = 0;
	for (const e of prefix) await seed.append("s", "r1", { ...e, seq: seq++ } as Event);
	seed.closeAll();
	const agentB = createAgent({ model: "faux", store: new SessionStore(dirB), tools: [today], adapter: answering, extensions: [gate] } as unknown as AgentDefinition);
	const sB = await agentB.session({ id: "s" });
	for await (const _ of sB.resume()) void _;
	const logB = [...sB.log.all];
	agentB.close();
	return { input, prefix, logB, file: readFileSync(join(workspace, "f.ts"), "utf8") };
}

describe("ADR-0061 — a pre-rename edit_file call, resumed after the rename", () => {
	it("APPROVED, not executed: runs exactly the persisted old-name input; the durable start keeps it as written", async () => {
		const r = await resumeAfterUpgrade(() => true);
		expect(r.prefix.some((e) => e.type === "permission_decided" && (e as { decision: string }).decision === "approved")).toBe(true);
		const started = r.logB.find((e) => e.type === "tool_execution_started") as (Event & { input: unknown }) | undefined;
		expect(started?.input).toStrictEqual(r.input);
		expect(r.logB.some((e) => e.type === "tool_execution_succeeded")).toBe(true);
		expect(r.file).toBe("B\n");
	});

	it("UNDECIDED: refused once as invalid_input against today's schema — no decision, no approval prompt, no execution", async () => {
		const r = await resumeAfterUpgrade((e) => e.type !== "permission_decided" && e.type !== "permission_requested");
		const results = r.logB.filter((e) => e.type === "tool_result") as (Event & { content: string; isError: boolean; errorKind?: string })[];
		expect(results).toHaveLength(1);
		expect(results[0]!.isError).toBe(true);
		expect(results[0]!.errorKind).toBe("invalid_input");
		expect(results[0]!.content).toMatch(/^Arguments failed schema validation/);
		expect(r.logB.some((e) => e.type === "permission_decided" || e.type === "permission_requested" || e.type === "tool_execution_started")).toBe(false);
		expect(r.file).toBe("A\n");
	});
});
