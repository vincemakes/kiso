/**
 * WR-1A ④a — the resume gate: recovery re-asks reality from the durable
 * invocation. Not a unit claim — the REAL chain: SessionStore → a durable,
 * committed tool_call_end carrying expectedRevision → process death BEFORE
 * execution → resume() → the recovery executes the SAME persisted
 * invocation against the CURRENT disk.
 *
 *   disk still A → executes (the write lands, receipt succeeded)
 *   disk moved B → refuses (precondition receipt; B intact)
 *
 * Same code path both ways — no special recovery case exists to test.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { writeFileTool } from "@vincemakes/kiso-tools-node";
import type { Event } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

const rev = (s: string): string => `rev:${createHash("sha256").update(Buffer.from(s)).digest("hex").slice(0, 16)}`;
const DONE: FauxScript = [{ events: [{ type: "stop", reason: "end_turn" }] }];

/** The durable prefix: a COMMITTED turn (call + stop) whose approved
 *  write_file cites revision A — persisted, never executed (the crash
 *  window opened after commit, before START). */
function seedFor(citedRev: string): readonly Event[] {
	return [
		{ seq: 0, type: "user_input", content: "apply the change" },
		{ seq: 1, type: "tool_call_end", callId: "c1", name: "write_file", input: { path: "f.ts", content: "NEW CONTENT\n", expectedRevision: citedRev } },
		{ seq: 2, type: "permission_decided", decisionId: "d1", callId: "c1", decision: "approved", decidedBy: "mode:default" },
		{ seq: 3, type: "stop", reason: "tool_use" },
	] as unknown as readonly Event[];
}

async function resumeAndDrain(dir: string, workspace: string): Promise<readonly Event[]> {
	const store = new SessionStore(dir);
	const session = await createAgent({
		model: "faux",
		store,
		tools: [writeFileTool({ workspaceRoot: workspace })],
		adapter: createFauxProvider(DONE),
	}).session({ id: "s" });
	const events: Event[] = [];
	for await (const ev of session.resume()) events.push(ev);
	store.closeAll();
	return events;
}

describe("WR-1A ④a — recovery re-asks reality (the executable invariant)", () => {
	it("disk still A: the persisted invocation EXECUTES on resume — the write lands once", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-wr1a-res-"));
		const workspace = mkdtempSync(join(tmpdir(), "kiso-wr1a-ws-"));
		writeFileSync(join(workspace, "f.ts"), "A\n");
		const store = new SessionStore(dir);
		for (const ev of seedFor(rev("A\n"))) await store.append("s", "r1", ev);
		store.closeAll();

		const events = await resumeAndDrain(dir, workspace);
		const succeeded = events.filter((e) => e.type === "tool_execution_succeeded");
		expect(succeeded).toHaveLength(1);
		expect(readFileSync(join(workspace, "f.ts"), "utf8")).toBe("NEW CONTENT\n");
		expect(events.find((e) => e.type === "terminal")).toMatchObject({ outcome: { kind: "completed" } });
	});

	it("disk moved to B while dead: the SAME invocation REFUSES — B intact, precondition receipt durable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-wr1a-res-"));
		const workspace = mkdtempSync(join(tmpdir(), "kiso-wr1a-ws-"));
		writeFileSync(join(workspace, "f.ts"), "A\n");
		const store = new SessionStore(dir);
		for (const ev of seedFor(rev("A\n"))) await store.append("s", "r1", ev);
		store.closeAll();

		// the world moves while the process is dead
		writeFileSync(join(workspace, "f.ts"), "B — the user edited\n");

		const events = await resumeAndDrain(dir, workspace);
		const failed = events.filter((e) => e.type === "tool_execution_failed");
		expect(failed).toHaveLength(1);
		expect((failed[0] as Event & { type: "tool_execution_failed" }).errorKind).toBe("precondition");
		expect(readFileSync(join(workspace, "f.ts"), "utf8")).toBe("B — the user edited\n");
		// and the refusal carries NO partial-effects note — nothing ran
		const result = events.find((e) => e.type === "tool_result");
		expect(String((result as Event & { type: "tool_result" }).content)).not.toContain("partially applied");
	});
});
