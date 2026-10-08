/**
 * The committed revision witness (kiso-doc plan-revision-witness rev 1,
 * owner-approved 2026-10-08): the model may omit `expectedRevision` on
 * edit_file / write_file, and kiso binds it — BEFORE the durable start —
 * from the last [rev:…] the COMMITTED trajectory (the projection) shows
 * for that file. Amends WR-1 v2's "the model cites it back"; keeps every
 * invariant v2 protects: a voided observation never becomes a witness,
 * the disk is never the witness, the stale guard refuses an outside write,
 * an existing file nobody read is refused.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { editFileTool, readFileTool, writeFileTool } from "@vincemakes/kiso-tools-node";
import type { Event } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

const rev = (s: string): string => `rev:${createHash("sha256").update(Buffer.from(s)).digest("hex").slice(0, 16)}`;
const call = (callId: string, name: string, input: Record<string, unknown>) => ({ type: "tool_call_end" as const, callId, name, input });
const step = (...calls: ReturnType<typeof call>[]) => ({ events: [...calls, { type: "stop" as const, reason: "tool_use" as const }] });
const say = (text: string) => ({ events: [{ type: "text_delta" as const, text }, { type: "stop" as const, reason: "end_turn" as const }] });

function world(files: Record<string, string>) {
	const workspace = mkdtempSync(join(tmpdir(), "kiso-witness-ws-"));
	for (const [p, c] of Object.entries(files)) writeFileSync(join(workspace, p), c);
	const dir = mkdtempSync(join(tmpdir(), "kiso-witness-"));
	const tools = [readFileTool({ workspaceRoot: workspace }), writeFileTool({ workspaceRoot: workspace }), editFileTool({ workspaceRoot: workspace })];
	return { workspace, dir, tools, file: (p: string) => readFileSync(join(workspace, p), "utf8") };
}

async function run(w: ReturnType<typeof world>, script: FauxScript, input = "go", id = "s"): Promise<Event[]> {
	const store = new SessionStore(w.dir);
	const session = await createAgent({ model: "faux", store, tools: w.tools, adapter: createFauxProvider(script) }).session({ id });
	const events: Event[] = [];
	for await (const ev of session.run(input)) events.push(ev);
	store.closeAll();
	return events;
}

const started = (events: readonly Event[], callId: string) =>
	events.find((e) => e.type === "tool_execution_started" && (e as { callId: string }).callId === callId) as { input: Record<string, unknown> } | undefined;
const outcome = (events: readonly Event[], callId: string) =>
	events.find((e) => (e.type === "tool_execution_succeeded" || e.type === "tool_execution_failed") && (e as { callId: string }).callId === callId) as
		| { type: string; error?: string; errorKind?: string }
		| undefined;

describe("the committed revision witness", () => {
	it("read, then edit without expectedRevision: kiso binds the read's revision before the durable start", async () => {
		const w = world({ "f.ts": "A\n" });
		const events = await run(w, [step(call("r1", "read_file", { path: "f.ts" })), step(call("e1", "edit_file", { path: "f.ts", search: "A", replace: "B" })), say("done")]);
		expect(outcome(events, "e1")?.type).toBe("tool_execution_succeeded");
		expect(started(events, "e1")?.input.expectedRevision).toBe(rev("A\n"));
		expect(w.file("f.ts")).toBe("B\n");
	});

	it("two edits of one file in ONE message chain through the first edit's receipt", async () => {
		const w = world({ "f.ts": "one\ntwo\n" });
		const events = await run(w, [
			step(call("r1", "read_file", { path: "f.ts" })),
			step(call("e1", "edit_file", { path: "f.ts", search: "one", replace: "ONE" }), call("e2", "edit_file", { path: "f.ts", search: "two", replace: "TWO" })),
			say("done"),
		]);
		expect(outcome(events, "e1")?.type).toBe("tool_execution_succeeded");
		expect(outcome(events, "e2")?.type).toBe("tool_execution_succeeded");
		expect(started(events, "e2")?.input.expectedRevision).toBe(rev("ONE\ntwo\n"));
		expect(w.file("f.ts")).toBe("ONE\nTWO\n");
	});

	it("an existing file the session never read is refused: read it first", async () => {
		const w = world({ "f.ts": "A\n" });
		const events = await run(w, [step(call("e1", "edit_file", { path: "f.ts", search: "A", replace: "B" })), say("done")]);
		const o = outcome(events, "e1");
		expect(o?.type).toBe("tool_execution_failed");
		expect(o?.errorKind).toBe("precondition");
		expect(o?.error).toMatch(/read it first/);
		expect(started(events, "e1")?.input.expectedRevision).toBeUndefined();
		expect(w.file("f.ts")).toBe("A\n");
	});

	it("an outside write after the witness is refused as stale — the guard is unchanged", async () => {
		const w = world({ "f.ts": "A\n" });
		await run(w, [step(call("r1", "read_file", { path: "f.ts" })), say("read")], "look");
		writeFileSync(join(w.workspace, "f.ts"), "A — edited by the person\n");
		const events = await run(w, [step(call("e1", "edit_file", { path: "f.ts", search: "A", replace: "B" })), say("done")], "change it");
		const o = outcome(events, "e1");
		expect(o?.type).toBe("tool_execution_failed");
		expect(o?.errorKind).toBe("precondition");
		expect(started(events, "e1")?.input.expectedRevision).toBe(rev("A\n"));
		expect(w.file("f.ts")).toBe("A — edited by the person\n");
	});

	it("a VOIDED draft's read is never a witness, even when its revision equals the disk's", async () => {
		const w = world({ "f.ts": "A\n" });
		// The WR-1 gate's shape: text, then the call, then its receipt, and no
		// stop. Recovery VOIDS this draft (model_output_abandoned) and its
		// revision leaves the projection. (A draft that is ONLY a complete
		// call is a committed prefix — ADR-0047 — and its read IS a witness:
		// the witness follows the projection exactly.)
		const seed: readonly Event[] = [
			{ seq: 0, type: "user_input", content: "look at f.ts" },
			{ seq: 1, type: "text_delta", text: "let me read it" },
			{ seq: 2, type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "f.ts" } },
			{ seq: 3, type: "tool_execution_started", executionId: "ex1", callId: "c1", name: "read_file", input: { path: "f.ts" } },
			{ seq: 4, type: "tool_execution_succeeded", executionId: "ex1", callId: "c1", result: { content: `A\n\n[${rev("A\n")}]`, isError: false } },
			// no stop: the draft never committed
		] as unknown as readonly Event[];
		const store = new SessionStore(w.dir);
		for (const ev of seed) await store.append("s", "r1", ev);
		store.closeAll();
		const live = new SessionStore(w.dir);
		const session = await createAgent({ model: "faux", store: live, tools: w.tools, adapter: createFauxProvider([say("recovered")]) }).session({ id: "s" });
		for await (const _ of session.resume()) void _;
		live.closeAll();

		const events = await run(w, [step(call("e1", "edit_file", { path: "f.ts", search: "A", replace: "B" })), say("done")], "now edit it");
		expect(outcome(events, "e1")?.errorKind).toBe("precondition");
		expect(started(events, "e1")?.input.expectedRevision).toBeUndefined();
		expect(w.file("f.ts")).toBe("A\n");
	});

	it("write_file: an absent path is created; an existing unread file is refused; after a read it is replaced", async () => {
		const w = world({ "old.ts": "OLD\n" });
		const events = await run(w, [
			step(call("w1", "write_file", { path: "new.ts", content: "NEW\n" })),
			step(call("w2", "write_file", { path: "old.ts", content: "CLOBBER\n" })),
			step(call("r1", "read_file", { path: "old.ts" })),
			step(call("w3", "write_file", { path: "old.ts", content: "REPLACED\n" })),
			say("done"),
		]);
		expect(outcome(events, "w1")?.type).toBe("tool_execution_succeeded");
		expect(w.file("new.ts")).toBe("NEW\n");
		expect(outcome(events, "w2")?.errorKind).toBe("precondition");
		expect(outcome(events, "w3")?.type).toBe("tool_execution_succeeded");
		expect(started(events, "w3")?.input.expectedRevision).toBe(rev("OLD\n"));
		expect(w.file("old.ts")).toBe("REPLACED\n");
	});

	it("a revision the model supplies is honoured as before, never replaced by the witness", async () => {
		const w = world({ "f.ts": "A\n" });
		const events = await run(w, [
			step(call("r1", "read_file", { path: "f.ts" })),
			step(call("e1", "edit_file", { path: "f.ts", search: "A", replace: "B", expectedRevision: "rev:0000000000000000" })),
			say("done"),
		]);
		expect(started(events, "e1")?.input.expectedRevision).toBe("rev:0000000000000000");
		expect(outcome(events, "e1")?.errorKind).toBe("precondition");
		expect(w.file("f.ts")).toBe("A\n");
	});

	it("resume: an approved call that never started is bound on the recovery path too", async () => {
		const w = world({ "f.ts": "A\n" });
		const seed: readonly Event[] = [
			{ seq: 0, type: "user_input", content: "edit f.ts" },
			{ seq: 1, type: "tool_call_end", callId: "r1", name: "read_file", input: { path: "f.ts" } },
			{ seq: 2, type: "stop", reason: "tool_use" },
			{ seq: 3, type: "tool_execution_started", executionId: "ex-3", callId: "r1", invocationSeq: 1, name: "read_file", input: { path: "f.ts" } },
			{ seq: 4, type: "tool_execution_succeeded", executionId: "ex-3", callId: "r1", invocationSeq: 1, result: { content: `A\n\n[${rev("A\n")}]`, isError: false } },
			{ seq: 5, type: "tool_result", callId: "r1", content: `A\n\n[${rev("A\n")}]`, isError: false },
			{ seq: 6, type: "tool_call_end", callId: "e1", name: "edit_file", input: { path: "f.ts", search: "A", replace: "B" } },
			{ seq: 7, type: "permission_decided", decisionId: "d1", callId: "e1", decision: "approved", decidedBy: "mode:default" },
			{ seq: 8, type: "stop", reason: "tool_use" },
		] as unknown as readonly Event[];
		const store = new SessionStore(w.dir);
		for (const ev of seed) await store.append("s", "r1", ev);
		store.closeAll();
		const live = new SessionStore(w.dir);
		const session = await createAgent({ model: "faux", store: live, tools: w.tools, adapter: createFauxProvider([say("done")]) }).session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.resume()) events.push(ev);
		live.closeAll();
		expect(started(events, "e1")?.input.expectedRevision).toBe(rev("A\n"));
		expect(outcome(events, "e1")?.type).toBe("tool_execution_succeeded");
		expect(w.file("f.ts")).toBe("B\n");
	});
});
