/** seedLog / messagesToEvents: the encoder that moved out of the kernel keeps its contract (the kernel's own copy no longer exists). */
import { describe, expect, it } from "vitest";
import { EventLog, projectMessages, type Message } from "@vincemakes/kiso-core";
import { messagesToEvents, seedLog } from "../src/seed.js";

const RICH: Message[] = [
	{ role: "user", content: "first" },
	{ role: "assistant", blocks: [{ type: "text", text: "a" }, { type: "tool_use", callId: "c1", name: "read", input: { path: "x" }, rawInput: "{\"path\":\"x\"}" }, { type: "text", text: "b" }], reasoning: "thought" },
	{ role: "tool", callId: "c1", content: "result", isError: false, tags: ["t"] },
	{ role: "user", content: [{ type: "text", text: "blocks" }], source: "system" },
] as never;

describe("seedLog", () => {
	it("encodes to a log whose sequence numbers run 0..n-1 and whose projection is the input (the round trip, across the package boundary)", () => {
		const log = seedLog(RICH);
		expect(log.all.map((e) => e.seq)).toEqual(log.all.map((_, i) => i));
		expect(projectMessages(log.all)).toEqual(RICH);
		expect(log.all.length).toBe(messagesToEvents(RICH).length);
	});
	it("no messages: an empty log", () => { expect(seedLog([]).all).toEqual([]); });
	it("a log that already holds events is returned untouched (a resumed session already holds everything)", () => {
		const log = seedLog([{ role: "user", content: "kept" }]);
		const before = JSON.stringify(log.all);
		const same = seedLog(RICH, log);
		expect(same).toBe(log);
		expect(JSON.stringify(same.all)).toBe(before);
	});
	it("an empty log handed in by the caller is the one seeded (any object with append and all)", () => {
		const mine = new EventLog();
		expect(seedLog(RICH, mine)).toBe(mine);
		expect(mine.all.length).toBeGreaterThan(0);
	});
});
