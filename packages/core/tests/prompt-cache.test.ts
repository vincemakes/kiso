/**
 * D 区 — the prompt-cache byte discipline.
 *
 * Contract: the SAME event-stream prefix must project to a BYTE-IDENTICAL
 * message prefix (JSON.stringify, element for element). New events only
 * ever change the projection at the TAIL; the sole exception is the
 * `microcompacted` boundary — an explicit persisted fact whose replay
 * derives the same projection every time.
 */

import { describe, expect, it } from "vitest";
import { EventLog, projectMessages } from "../src/index.js";

describe("D: byte-identical projection discipline", () => {
	it("① the same log projects identically twice — byte for byte", () => {
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		log.append({ type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a.ts" } });
		log.append({ type: "tool_result", callId: "c1", content: "line1\nline2\n", isError: false });
		log.append({ type: "stop", reason: "end_turn" });
		const a = projectMessages(log.all);
		const b = projectMessages(log.all);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		expect(a).toHaveLength(b.length);
	});

	it("② appending one more turn leaves the OLD PREFIX byte-identical", () => {
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		log.append({ type: "tool_call_end", callId: "c1", name: "shell", input: { command: "npm test" } });
		log.append({ type: "tool_result", callId: "c1", content: "pass\n", isError: false });
		log.append({ type: "stop", reason: "end_turn" });
		log.append({ type: "terminal", outcome: { kind: "completed" } });
		const before = projectMessages(log.all);

		// A second user turn appends to the stream.
		log.append({ type: "user_input", content: "more" });
		log.append({ type: "tool_call_end", callId: "c2", name: "list_dir", input: {} });
		log.append({ type: "tool_result", callId: "c2", content: "dir a/\n", isError: false });
		log.append({ type: "stop", reason: "end_turn" });
		log.append({ type: "terminal", outcome: { kind: "completed" } });
		const after = projectMessages(log.all);

		// The prefix is unchanged, element for element, byte for byte.
		expect(after.length).toBeGreaterThan(before.length);
		const prefix = after.slice(0, before.length);
		expect(JSON.stringify(prefix)).toBe(JSON.stringify(before));
	});

	it("③ after a microcompact boundary, a reloaded (JSON round-trip) log projects byte-identically to memory", () => {
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		for (let i = 0; i < 8; i++) {
			log.append({ type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.ts` } });
			log.append({ type: "tool_result", callId: `r${i}`, content: "line\n".repeat(50), isError: false });
			log.append({ type: "user_input", content: `t${i}` });
		}
		log.append({ type: "microcompacted", beforeSeq: 3 });
		const inMemory = projectMessages(log.all);
		// A crash + resume replays the SAME events from disk.
		const reloaded = projectMessages(JSON.parse(JSON.stringify(log.all)) as Parameters<typeof projectMessages>[0]);
		expect(JSON.stringify(reloaded)).toBe(JSON.stringify(inMemory));
	});
});
