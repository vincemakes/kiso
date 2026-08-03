/**
 * 第四轮(二) — Session poison is PERMANENT and total.
 *
 * 1. ANY rejected disk write poisons the session — not only the typed
 *    stale/corruption errors (a live external writer's lock error is the
 *    realistic case).
 * 2. The run iterator re-checks health when it STARTS (a run constructed
 *    before the poison must fail on consumption), and every persist path
 *    checks before touching the log or the disk.
 * 3. approve()/resolveUncertain() — methods that mutate the log — refuse
 *    on a poisoned session.
 * 4. Once the in-memory log may disagree with the disk, the session never
 *    accumulates seqs and "catches up": the poison is irreversible.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

const STOP: FauxScript = [{ events: [{ type: "stop", reason: "end_turn" }] }];

function fauxAgent(store: SessionStore) {
	return createAgent({
		model: "faux",
		store,
		tools: [],
		adapter: createFauxProvider(STOP),
	});
}

/** A terminated run owns the lock so a second writer's run() is legal. */
async function seedTerminated(store: SessionStore, seq0: number): Promise<void> {
	await store.append("s", "r0", { seq: seq0, type: "user_input", content: "seed" });
	await store.append("s", "r0", { seq: seq0 + 1, type: "terminal", outcome: { kind: "completed" } });
}

describe("permanent poison (第四轮)", () => {
	it("a session whose writes failed against a LIVE writer stays poisoned forever — even after the lock frees", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-poison-"));
		const storeA = new SessionStore(dir);
		await seedTerminated(storeA, 0);

		// B loads the session; every write conflicts with A's live lock.
		const sessionB = await fauxAgent(new SessionStore(dir)).session({ id: "s" });
		await expect(async () => {
			for await (const _ev of sessionB.run("hello")) {
				// never
			}
		}).rejects.toThrow(/locked by another writer/);

		// The disk moves on while B is poisoned.
		await storeA.append("s", "r1", { seq: 2, type: "user_input", content: "a-2" });
		storeA.closeAll(); // the lock frees — but B is permanently poisoned

		// Every path fails fast with PoisonedSessionError; NOTHING of B's
		// context ever lands, even though the lock is now free.
		await expect(async () => {
			for await (const _ev of sessionB.run("second")) {
				// never
			}
		}).rejects.toThrow(/poisoned/i);
		await expect(async () => {
			for await (const _ev of sessionB.resume()) {
				// never
			}
		}).rejects.toThrow(/poisoned/i);
		await expect(sessionB.approve("d-1", true)).rejects.toThrow(/poisoned/i);
		await expect(sessionB.resolveUncertain("ex-1", "abandoned")).rejects.toThrow(/poisoned/i);

		const records = new SessionStore(dir).load("s");
		expect(records.map((r) => r.event.seq)).toEqual([0, 1, 2]); // only A's writes
		expect(records.some((r) => r.event.type === "user_input" && r.event.content === "hello")).toBe(false);
		expect(records.some((r) => r.event.type === "user_input" && r.event.content === "second")).toBe(false);
	});

	it("runs constructed BEFORE the poison all fail on consumption — nothing of their context reaches the disk", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-poison-"));
		const storeA = new SessionStore(dir);
		await seedTerminated(storeA, 0);

		const sessionB = await fauxAgent(new SessionStore(dir)).session({ id: "s" });
		// PRE-CONSTRUCT two runs while the session is still healthy.
		const run1 = sessionB.run("one");
		const run2 = sessionB.run("two");

		// A third writer takes the lock (after A released it); run1's first
		// append fails → poison. C's own run is TERMINATED so the open-run
		// guard lets B's run reach the write.
		storeA.closeAll();
		const storeC = new SessionStore(dir);
		await storeC.append("s", "r1", { seq: 2, type: "user_input", content: "c-1" });
		await storeC.append("s", "r1", { seq: 3, type: "terminal", outcome: { kind: "completed" } });
		await expect(async () => {
			for await (const _ev of run1) {
				// never
			}
		}).rejects.toThrow(/locked by another writer|poisoned/i);

		// run2 was constructed before the poison — it must STILL fail when
		// consumed, and must not write anything.
		await expect(async () => {
			for await (const _ev of run2) {
				// never
			}
		}).rejects.toThrow(/poisoned/i);

		const records = new SessionStore(dir).load("s");
		expect(records.map((r) => r.event.seq)).toEqual([0, 1, 2, 3]); // A + C only
		expect(records.some((r) => r.event.type === "user_input" && r.event.content === "one")).toBe(false);
		expect(records.some((r) => r.event.type === "user_input" && r.event.content === "two")).toBe(false);
	});
});
