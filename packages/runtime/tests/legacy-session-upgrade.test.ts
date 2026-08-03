/**
 * 第四轮(四) — durable sessions written by the PREVIOUS framework round
 * must load, project, and resume under the current schema.
 *
 * Round three changed `compacted.cleared` from the callId-keyed shape
 * `{callId, content}` (v1) to the eventSeq-keyed shape
 * `{eventSeq, callId, content}` (v2). A session written at 573e9d2 with a
 * v1 compacted record must NOT be rejected as corruption: the store
 * loads it, the projection applies its replacements (v1 semantics: by
 * callId, exactly as the old framework did), and resume() continues the
 * run to its terminal. New records keep the v2 exact-replacement
 * semantics.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@kiso/evals";
import { isKisoEvent, projectMessages } from "@kiso/core";
import { createAgent, SessionStore } from "../src/index.js";

/**
 * The v1 compacted shape exactly as 573e9d2 wrote it: cleared entries are
 * {callId, content} — no eventSeq.
 */
const V1_CLEARED = [{ callId: "c1", content: "[content cleared — reference by revision] old marker" }];

function v1SessionLog(dir: string, open: boolean): void {
	const records: string[] = [];
	const push = (runId: string, event: unknown): void => {
		records.push(JSON.stringify({ runId, ts: 1, event }));
	};
	push("r1", { seq: 0, type: "user_input", content: "go" });
	push("r1", { seq: 1, type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } });
	push("r1", { seq: 2, type: "tool_result", callId: "c1", content: "original long result", isError: false });
	push("r1", { seq: 3, type: "compacted", cleared: V1_CLEARED });
	if (!open) {
		push("r1", { seq: 4, type: "stop", reason: "end_turn" });
		push("r1", { seq: 5, type: "terminal", outcome: { kind: "completed" } });
	}
	writeFileSync(join(dir, "s.jsonl"), records.join("\n") + "\n", "utf8");
}

describe("v1 compacted sessions upgrade (第四轮)", () => {
	it("a v1 {callId, content} compacted record loads — it is NOT corruption", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-v1-"));
		v1SessionLog(dir, true);
		const records = new SessionStore(dir).load("s");
		expect(records).toHaveLength(4);
		const compacted = records[3]!.event;
		expect(compacted.type).toBe("compacted");
		expect(isKisoEvent(compacted)).toBe(true); // the v1 shape is legal
	});

	it("the projection applies a v1 replacement by callId — exactly like the old framework", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-v1-"));
		v1SessionLog(dir, true);
		const records = new SessionStore(dir).load("s");
		const projected = projectMessages(records.map((r) => r.event));
		const tool = projected.find((m) => m.role === "tool");
		expect(tool?.content).toBe("[content cleared — reference by revision] old marker");
	});

	it("resume() drives a v1 session to its terminal — the migration is live", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-v1-"));
		v1SessionLog(dir, false); // everything terminated except… v1 run is CLOSED
		const agent = createAgent({
			model: "faux",
			store: new SessionStore(dir),
			tools: [],
			adapter: createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]),
		});
		const session = await agent.session({ id: "s" });
		// A v1 session with a terminated run loads and continues with a NEW
		// run (the projected history — with the v1 replacement applied —
		// feeds the provider).
		const seen: unknown[] = [];
		for await (const ev of session.run("again")) seen.push(ev);
		expect(seen.some((e) => (e as { type?: string }).type === "terminal")).toBe(true);
		expect(new SessionStore(dir).load("s").length).toBeGreaterThan(4); // grew durably
	});

	it("an OPEN v1 run resumes: the recovery sees the v1 log and completes it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-v1-"));
		v1SessionLog(dir, true); // r1 has NO terminal — it is open
		const agent = createAgent({
			model: "faux",
			store: new SessionStore(dir),
			tools: [],
			adapter: createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]),
		});
		const session = await agent.session({ id: "s" });
		const events: import("@kiso/core").Event[] = [];
		for await (const ev of session.resume()) events.push(ev);
		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal?.outcome.kind).toBe("completed");
		// The v1 compacted record survived untouched in the log.
		const records = new SessionStore(dir).load("s");
		expect(records.some((r) => r.event.type === "compacted" && (r.event as unknown as { cleared: unknown[] }).cleared.length === 1)).toBe(true);
	});
});
