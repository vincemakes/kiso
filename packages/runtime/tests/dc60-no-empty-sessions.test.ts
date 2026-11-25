/**
 * DC-60 — a session that never began leaves nothing on disk.
 *
 * The owner's disk on 2026-09-23 held 28 sessions with a sidecar (revision
 * 1, a summary row) and a trace (header + run_end) and NO log: every one
 * was a process that opened a session, ran the start-up recovery (a
 * resume with nothing to recover), and exited. They showed up in /resume
 * as "no summary" cards. Twelve were delegated children.
 *
 * The rule now: nothing of a NEW session reaches the disk before its first
 * durable event. Its revision 1 — with the workspace it opened in — lands
 * with that event, still BEFORE it (the XP-1 order: a log line never
 * exists without its profile).
 */

import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "../src/index.js";
import { readProfile } from "../src/profile.js";

const DONE = { events: [{ type: "text_delta" as const, text: "done" }, { type: "stop" as const, reason: "end_turn" as const }] };

/** Every file under the store root that names the session. */
function filesOf(dir: string, id: string): string[] {
	const top = readdirSync(dir).filter((f) => f.startsWith(`${id}.`));
	const traces = existsSync(join(dir, "traces")) ? readdirSync(join(dir, "traces")).filter((f) => f.startsWith(`${id}.`)).map((f) => `traces/${f}`) : [];
	return [...top, ...traces].sort();
}

describe("DC-60 — nothing of a new session is on disk before its first durable event", () => {
	it("open + the start-up recovery with nothing to recover leaves NO file (0.40.2 left a sidecar and a trace)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-dc60-"));
		const store = new SessionStore(dir);
		const agent = createAgent({ model: "faux", store, tools: [], adapter: createFauxProvider([]), workspace: "/w" });
		const session = await agent.session({ id: "s" });
		for await (const _ of session.resume()) {
			// nothing to recover
		}
		await store.closeAll();
		expect(filesOf(dir, "s")).toEqual([]);
	});

	it("the first durable event brings revision 1, with the workspace the session opened in", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-dc60-"));
		const store = new SessionStore(dir);
		const agent = createAgent({ model: "faux", store, tools: [], adapter: createFauxProvider([DONE]), workspace: "/w" });
		const session = await agent.session({ id: "s" });
		for await (const _ of session.resume()) {
			// the start-up recovery, as the CLI runs it
		}
		for await (const _ of session.run("hello")) {
			// the first turn
		}
		await store.closeAll();
		expect(filesOf(dir, "s")).toEqual(["s.jsonl", "s.lock", "s.meta.json", "traces/s.jsonl"].filter((f) => f !== "s.lock" || existsSync(join(dir, "s.lock"))));
		const profile = readProfile(dir, "s");
		expect(profile.kind).toBe("ok");
		if (profile.kind === "ok") {
			expect(profile.profile.revision).toBe(1);
			expect(profile.profile.workspace).toBe("/w");
			expect(profile.profile.modelId).toBe("faux");
		}
	});

	it("a model switch before the first event stays in memory, and lands with it as revision 1", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-dc60-"));
		const store = new SessionStore(dir);
		const agent = createAgent({ model: "faux", store, tools: [], adapter: createFauxProvider([]), workspace: "/w" });
		const session = await agent.session({ id: "s" });
		session.setModelBinding({ adapter: createFauxProvider([DONE]), model: "faux-2" });
		expect(filesOf(dir, "s")).toEqual([]);
		for await (const _ of session.run("hello")) {
			// the first turn
		}
		await store.closeAll();
		const profile = readProfile(dir, "s");
		expect(profile.kind).toBe("ok");
		if (profile.kind === "ok") {
			expect(profile.profile.revision).toBe(1);
			expect(profile.profile.modelId).toBe("faux-2");
			expect(profile.profile.workspace).toBe("/w");
		}
	});
});
