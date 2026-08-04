/**
 * C 区 (kiso code review, fix 3): microcompact is wired THROUGH the runtime.
 *
 * A REAL AgentSession — not the bare loop — runs a session whose projected
 * context crosses the threshold: the `microcompacted` boundary must be
 * appended AND persisted exactly once, and a FRESH session loaded from the
 * same store must project the placeholders (the boundary is a durable fact,
 * D 区 byte discipline). This is the end-to-end wiring test the review
 * demanded: a core-level test alone would pass without any runtime wiring.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import type { Event } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

const END: FauxScript = [{ events: [{ type: "stop", reason: "end_turn" }] }];

/** Seed a long session DIRECTLY in the store: the shape a real session has
 *  after many turns — one user turn per chunky read result. */
async function seedLongSession(store: SessionStore): Promise<void> {
	let seq = 0;
	await store.append("s", "r1", { seq: seq++, type: "user_input", content: "start" });
	for (let i = 0; i < 7; i++) {
		await store.append("s", "r1", {
			seq: seq++,
			type: "tool_call_end",
			callId: `r${i}`,
			name: "read_file",
			input: { path: `f${i}.ts` },
		});
		await store.append("s", "r1", {
			seq: seq++,
			type: "tool_result",
			callId: `r${i}`,
			content: "line\n".repeat(200), // ~1000 chars ≈ 250 tokens each
			isError: false,
		});
		await store.append("s", "r1", { seq: seq++, type: "user_input", content: `t${i}` });
	}
}

describe("C 区 e2e: microcompact is wired through the runtime", () => {
	it("an over-threshold session records the boundary on disk; a reloaded session projects the placeholders", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mc-e2e-"));
		const store = new SessionStore(dir);
		await seedLongSession(store);

		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter: createFauxProvider(END),
			microcompact: { thresholdTokens: 100 },
		});

		// The seeded session has an OPEN run (the crash shape) — it is
		// continued via resume(), like the kill -9 flow. The continuation
		// crosses the threshold BEFORE its first model turn: the boundary
		// is appended and persisted, exactly once, and the run completes.
		const session = await agent.session({ id: "s" });
		const seen: Event[] = [];
		for await (const ev of session.resume()) {
			seen.push(ev);
		}
		const durable = new SessionStore(dir).load("s").map((r) => r.event);
		expect(durable.filter((e) => e.type === "microcompacted")).toHaveLength(1);
		expect(seen.some((e) => e.type === "microcompacted")).toBe(true);
		expect(durable.some((e) => e.type === "terminal")).toBe(true);

		// A FRESH session from disk projects the compacted view: the old
		// results became placeholders, the recent window is untouched.
		const reloaded = await agent.session({ id: "s" });
		const tools = reloaded.projected().filter((m) => m.role === "tool");
		const oldResult = tools.find((m) => m.callId === "r0");
		const recentResult = tools.find((m) => m.callId === "r6");
		expect(oldResult?.content).toBe("[old tool output cleared: read_file f0.ts]");
		expect(recentResult?.content).toBe("line\n".repeat(200));
	});
});
