/**
 * C 区 — MicroCompact: zero-API context relief at the projection layer.
 *
 * - a `microcompacted` boundary event is a PERSISTED FACT: it records the
 *   seq up to which compactable tool results are cleared; the projection
 *   derives the cleared view from it deterministically — the same events
 *   always derive the same messages, byte for byte, across crash/resume;
 * - the whitelist is read/list/search/shell; write/edit outputs are never
 *   cleared; do-not-compact tagged results are never cleared;
 * - recent turns stay intact (KEEP_RECENT_TURNS);
 * - the loop appends the boundary ONCE when the estimated context exceeds
 *   the threshold — never a per-turn progressive clearing.
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
		const fresh = projected.find((m) => m.role === "tool" && m.callId === "r2");
		expect(fresh?.content).toBe("fresh content"); // inside the recent window
	});

	it("the boundary event itself is a persisted fact — two projections agree byte for byte (D 区)", () => {
		const log = seedLog();
		log.append({ type: "microcompacted", beforeSeq: 2 });
		const a = projectMessages(log.all);
		const b = projectMessages(log.all);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});

describe("C: the loop appends the boundary once when over the threshold", () => {
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
		expect(boundaries).toHaveLength(1); // ONE decision, never per-turn
		expect(events.some((e) => e.type === "microcompacted")).toBe(true); // yielded
		// The projection with the boundary equals the in-memory projection:
		// the persisted fact derives the same view (D 区).
		const inMemory = projectMessages(log.all);
		const reloaded = projectMessages(
			(JSON.parse(JSON.stringify(log.all)) as Event[]),
		);
		expect(JSON.stringify(reloaded)).toBe(JSON.stringify(inMemory));
	});
});
