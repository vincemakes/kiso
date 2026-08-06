/**
 * C area — MicroCompact: zero-API context relief at the projection layer.
 *
 * - a `microcompacted` boundary event is a PERSISTED FACT: it records the
 *   seq up to which compactable tool results are cleared; the projection
 *   derives the cleared view from it deterministically — the same events
 *   always derive the same messages, byte for byte, across crash/resume;
 * - the whitelist is read/list/search/shell; write/edit outputs are never
 *   cleared; do-not-compact tagged results are never cleared;
 * - the boundary is drawn by COMPACTABLE-RESULT recentness (bootstrap #3): the
 *   newest K = 4 compactable results stay intact whatever turn they belong
 *   to — a single giant turn with many reads triggers;
 * - the loop appends at most ONE boundary per iteration when the estimated
 *   context exceeds the threshold; a context that is STILL over may append
 *   another at the next iteration — each boundary makes progress.
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { EventLog, loop, projectMessages } from "../src/index.js";
import { DO_NOT_COMPACT } from "../src/kernel/project.js";

function seedLog(): EventLog {
	const log = new EventLog();
	// One user turn with a big read result, an edit, and a tagged result.
	log.append({ type: "user_input", content: "go" });
	log.append({ type: "tool_call_end", callId: "r1", name: "read_file", input: { path: "big.ts" } });
	log.append({ type: "tool_result", callId: "r1", content: "line one\n".repeat(100), isError: false });
	log.append({ type: "tool_call_end", callId: "e1", name: "edit_file", input: { path: "a.ts", search: "x", replace: "y" } });
	log.append({ type: "tool_result", callId: "e1", content: "edited a.ts", isError: false });
	log.append({ type: "tool_call_end", callId: "s1", name: "shell", input: { command: "npm test" } });
	log.append({ type: "tool_result", callId: "s1", content: "pass", isError: false, tags: [DO_NOT_COMPACT] });
	return log;
}

describe("C: projection applies the microcompact boundary deterministically", () => {
	it("a boundary clears eligible OLD results with the placeholder, keeps recent turns, tags, and write/edit", () => {
		const log = seedLog();
		// Three more user turns make the first one "old".
		log.append({ type: "user_input", content: "t2" });
		log.append({ type: "user_input", content: "t3" });
		log.append({ type: "user_input", content: "t4" });
		log.append({ type: "user_input", content: "t5" });
		log.append({ type: "user_input", content: "t6" });
		log.append({ type: "user_input", content: "t7" });
		// Boundary: clear everything before the 6th user input (seq 5).
		log.append({ type: "microcompacted", beforeSeq: 6 });

		const projected = projectMessages(log.all);
		const tools = projected.filter((m) => m.role === "tool");
		const read = tools.find((m) => m.callId === "r1");
		const edit = tools.find((m) => m.callId === "e1");
		const shell = tools.find((m) => m.callId === "s1");
		// The old read_file output became the placeholder with its arg.
		expect(read?.content).toBe("[old tool output cleared: read_file big.ts]");
		// write/edit output is never cleared.
		expect(edit?.content).toBe("edited a.ts");
		// do-not-compact tagged results are never cleared.
		expect(shell?.content).toBe("pass");
	});

	it("recent turns (inside the boundary) stay fully intact", () => {
		const log = seedLog();
		log.append({ type: "user_input", content: "t2" });
		log.append({ type: "tool_call_end", callId: "r2", name: "read_file", input: { path: "new.ts" } });
		log.append({ type: "tool_result", callId: "r2", content: "fresh content", isError: false });
		log.append({ type: "microcompacted", beforeSeq: 0 });
		const projected = projectMessages(log.all);
		const fresh = projected.find(
			(m): m is import("@vincemakes/kiso-core").ToolResultMessage => m.role === "tool" && m.callId === "r2",
		);
		expect(fresh?.content).toBe("fresh content"); // inside the recent window
	});

	it("the boundary event itself is a persisted fact — two projections agree byte for byte (D area)", () => {
		const log = seedLog();
		log.append({ type: "microcompacted", beforeSeq: 2 });
		const a = projectMessages(log.all);
		const b = projectMessages(log.all);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});

describe("C: the loop appends the boundary when over the threshold", () => {
	it("a long session crosses the threshold and records exactly ONE boundary, then replays identically", async () => {
		const registry = new ToolRegistry();
		registry.register(
			defineTool({
				name: "web_search",
				description: "s",
				parameters: { type: "object" },
				execute: async () => ({ content: "x".repeat(400), isError: false }),
			}),
		);
		// 10 prior user turns with chunky read results — way over a tiny
		// threshold.
		const log = new EventLog();
		log.append({ type: "user_input", content: "start" });
		for (let i = 0; i < 10; i++) {
			log.append({ type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.ts` } });
			log.append({ type: "tool_result", callId: `r${i}`, content: "line\n".repeat(200), isError: false });
			log.append({ type: "user_input", content: `t${i}` });
		}
		const script: FauxScript = [
			{ events: [{ type: "stop", reason: "end_turn" }] },
		];
		const events: import("@vincemakes/kiso-core").Event[] = [];
		for await (const ev of loop({
			adapter: createFauxProvider(script),
			model: "faux",
			registry,
			log,
			microcompact: { thresholdTokens: 100 },
		})) {
			events.push(ev);
		}
		const boundaries = log.all.filter((e) => e.type === "microcompacted");
		expect(boundaries).toHaveLength(1); // at most one per loop iteration
		expect(events.some((e) => e.type === "microcompacted")).toBe(true); // yielded
		// The projection with the boundary equals the in-memory projection:
		// the persisted fact derives the same view (D area).
		const inMemory = projectMessages(log.all);
		const reloaded = projectMessages(
			JSON.parse(JSON.stringify(log.all)) as Parameters<typeof projectMessages>[0],
		);
		expect(JSON.stringify(reloaded)).toBe(JSON.stringify(inMemory));
	});

	it("bootstrap #3: a SINGLE user turn with 6 big reads triggers — the oldest cleared, the newest 4 kept", async () => {
		// The coding agent's main overflow shape: one turn, many reads.
		// The old user-turn boundary never fired here; the new one draws
		// the line by compactable-result recentness (K = 4).
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		for (let i = 0; i < 6; i++) {
			log.append({ type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.ts` } });
			log.append({ type: "tool_result", callId: `r${i}`, content: "line\n".repeat(200), isError: false });
		}
		const events: import("@vincemakes/kiso-core").Event[] = [];
		for await (const ev of loop({
			adapter: createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]),
			model: "faux",
			registry: new ToolRegistry(),
			log,
			microcompact: { thresholdTokens: 100 },
		})) {
			events.push(ev);
		}
		const boundaries = log.all.filter((e) => e.type === "microcompacted");
		expect(boundaries).toHaveLength(1);
		const projected = projectMessages(log.all);
		const tools = projected.filter((m) => m.role === "tool");
		const content = (callId: string): string | undefined =>
			tools.find((m) => m.callId === callId)?.content as string | undefined;
		// The two OLDEST reads were cleared, the newest K = 4 are intact.
		expect(content("r0")).toBe("[old tool output cleared: read_file f0.ts]");
		expect(content("r1")).toBe("[old tool output cleared: read_file f1.ts]");
		expect(content("r2")).toBe("line\n".repeat(200));
		expect(content("r5")).toBe("line\n".repeat(200));
	});

	it("bootstrap #3: still over after clearing — the NEXT iteration appends a second boundary that makes progress", async () => {
		// 8 giant reads in one turn; the model then reads AGAIN (a new big
		// result lands). Boundary 1 keeps the newest 4; the context is still
		// over, so the next iteration's boundary 2 clears the oldest
		// still-visible result — progress, never a repeated no-op.
		const registry = new ToolRegistry();
		registry.register(
			defineTool({
				name: "read_file",
				description: "s",
				parameters: { type: "object" },
				execute: async () => ({ content: "line\n".repeat(200), isError: false }),
			}),
		);
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		for (let i = 0; i < 8; i++) {
			log.append({ type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.ts` } });
			log.append({ type: "tool_result", callId: `r${i}`, content: "line\n".repeat(200), isError: false });
		}
		const script: FauxScript = [
			{ events: [{ type: "tool_call_end", callId: "r8", name: "read_file", input: { path: "f8.ts" } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "stop", reason: "end_turn" }] },
		];
		for await (const _ev of loop({
			adapter: createFauxProvider(script),
			model: "faux",
			registry,
			log,
			microcompact: { thresholdTokens: 100 },
		})) {
			// drain
		}
		const boundaries = log.all.filter((e) => e.type === "microcompacted");
		expect(boundaries).toHaveLength(2);
		const projected = projectMessages(log.all);
		const tools = projected.filter((m) => m.role === "tool");
		const content = (callId: string): string | undefined =>
			tools.find((m) => m.callId === callId)?.content as string | undefined;
		// Cleared: r0..r4. Intact: the newest K = 4 (r5..r8).
		expect(content("r0")).toBe("[old tool output cleared: read_file f0.ts]");
		expect(content("r4")).toBe("[old tool output cleared: read_file f4.ts]");
		expect(content("r5")).toBe("line\n".repeat(200));
		expect(content("r8")).toBe("line\n".repeat(200));
	});

	it("keepResults 2 keeps only the 2 newest compactable results", async () => {
		// The config's keepResults overrides the default K = 4: with 6 big
		// reads in one turn, only the 2 newest survive — r0..r3 cleared.
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		for (let i = 0; i < 6; i++) {
			log.append({ type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.ts` } });
			log.append({ type: "tool_result", callId: `r${i}`, content: "line\n".repeat(200), isError: false });
		}
		const events: import("@vincemakes/kiso-core").Event[] = [];
		for await (const ev of loop({
			adapter: createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]),
			model: "faux",
			registry: new ToolRegistry(),
			log,
			microcompact: { thresholdTokens: 100, keepResults: 2 },
		})) {
			events.push(ev);
		}
		const boundaries = log.all.filter((e) => e.type === "microcompacted");
		expect(boundaries).toHaveLength(1);
		expect(events.some((e) => e.type === "microcompacted")).toBe(true); // yielded
		const projected = projectMessages(log.all);
		const tools = projected.filter((m) => m.role === "tool");
		const content = (callId: string): string | undefined =>
			tools.find((m) => m.callId === callId)?.content as string | undefined;
		// keepResults 2: only the 2 NEWEST compactable results stay intact.
		expect(content("r0")).toBe("[old tool output cleared: read_file f0.ts]");
		expect(content("r3")).toBe("[old tool output cleared: read_file f3.ts]");
		expect(content("r4")).toBe("line\n".repeat(200));
		expect(content("r5")).toBe("line\n".repeat(200));
	});

	it("C6 (P4): tagged results never count toward the boundary — the count and the clearing share one rule", async () => {
		// keepResults 1: the ONLY clearable result (r0) sits within the keep
		// window; r1/r2 carry do-not-compact and are un-clearable forever.
		// The OLD count included the tagged ones, so it saw 3 "visible"
		// results and placed the boundary AT r1 — clearing r0 even though
		// nothing beyond the keep window could ever clear. The corrected
		// count excludes the tag — nothing to compact, no boundary.
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		for (let i = 0; i < 3; i++) {
			log.append({ type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.ts` } });
			log.append({
				type: "tool_result",
				callId: `r${i}`,
				content: "line\n".repeat(200),
				isError: false,
				...(i === 1 || i === 2 ? { tags: [DO_NOT_COMPACT] } : {}),
			});
		}
		for await (const _ev of loop({
			adapter: createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]),
			model: "faux",
			registry: new ToolRegistry(),
			log,
			microcompact: { thresholdTokens: 100, keepResults: 1 },
		})) {
			// drain
		}
		expect(log.all.filter((e) => e.type === "microcompacted")).toHaveLength(0);
		const projected = projectMessages(log.all);
		const tools = projected.filter((m) => m.role === "tool");
		expect(tools.find((m) => m.callId === "r0")?.content).toBe("line\n".repeat(200)); // nothing was cleared
	});

	it("C6 (P4): the boundary anchors on the newest CLEARABLE result, never a tagged one", async () => {
		// keepResults 2: r0 untagged, r1 TAGGED, r2/r3 untagged. The OLD
		// count anchored at r1 (the tagged result — which the projection
		// then keeps, silently shrinking the clearable window). The
		// corrected count anchors at r0, the 2nd-newest CLEARABLE result.
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		for (let i = 0; i < 4; i++) {
			log.append({ type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.ts` } });
			log.append({
				type: "tool_result",
				callId: `r${i}`,
				content: "line\n".repeat(200),
				isError: false,
				...(i === 1 ? { tags: [DO_NOT_COMPACT] } : {}),
			});
		}
		for await (const _ev of loop({
			adapter: createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]),
			model: "faux",
			registry: new ToolRegistry(),
			log,
			microcompact: { thresholdTokens: 100, keepResults: 2 },
		})) {
			// drain
		}
		const boundary = log.all.find((e) => e.type === "microcompacted");
		expect(boundary).toBeDefined();
		expect((boundary as { beforeSeq: number }).beforeSeq).toBe(
			log.all.find((e) => e.type === "tool_result" && e.callId === "r0")!.seq,
		);
		const projected = projectMessages(log.all);
		const tools = projected.filter((m) => m.role === "tool");
		// r0 cleared; the tagged r1 and the kept window stay intact.
		expect(tools.find((m) => m.callId === "r0")?.content).toBe("[old tool output cleared: read_file f0.ts]");
		expect(tools.find((m) => m.callId === "r1")?.content).toBe("line\n".repeat(200));
		expect(tools.find((m) => m.callId === "r2")?.content).toBe("line\n".repeat(200));
	});
});
