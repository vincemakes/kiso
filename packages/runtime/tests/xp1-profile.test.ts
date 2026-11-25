/**
 * XP-1 — the durable profile's session contract (the ratified spec §3.2/§3.3).
 *
 * Fail-closed, in order:
 *   a NEW session writes revision 1 BEFORE its first durable event;
 *   a CORRUPT sidecar is BLOCKED — never read as absent (the "corrupt =
 *     legacy = today's defaults" silent rebuild is the forbidden move);
 *   an ABSENT sidecar beside a log that carries scoped envelopes (the
 *     content-discernible XP-era marker) is a BLOCKED integrity case;
 *   an ABSENT sidecar beside a plain legacy log is NOT drift — the
 *     session restores under current configuration, revision 1 lands at
 *     the next explicit selection;
 *   a RECORDED profile is RESTORED: the session runs the recorded model,
 *     not the process default (the truthfulness core);
 *   a CHANGED BINDING never blocks (owner-ruled 2026-09-21): the CURRENT
 *     configuration wins, records the next revision, and says so;
 *   /model (setModelBinding) records the next revision durably.
 *
 * RED on the pre-XP-1b tree: no sidecar exists, nothing restores.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { buildProfile, profilePath, readProfile, writeProfile } from "../src/profile.js";
import { ToolRegistry } from "@vincemakes/kiso-core";

const DONE: Adapter = {
	stream: async function* () {
		yield { seq: 0, type: "text_delta", text: "ok" } as never;
		yield { seq: 0, type: "stop", reason: "end_turn" } as never;
	},
};

function freshDir(): string {
	return mkdtempSync(join(tmpdir(), "kiso-xp1-"));
}

describe("XP-1 — the sidecar's fail-closed lifecycle", () => {
	it("a NEW session writes revision 1 with its first durable event — and nothing at open (DC-60)", async () => {
		// DC-60, a declared change: this read "writes revision 1 before any
		// durable event" and pinned the write at OPEN — which left a sidecar
		// for every session that never began. Revision 1 now lands with the
		// first durable event, still before it.
		const dir = freshDir();
		const agent = createAgent({ model: "faux-y", store: new SessionStore(dir), tools: [], adapter: DONE });
		const session = await agent.session({ id: "s1" });
		expect(readProfile(dir, "s1").kind).toBe("absent");
		for await (const _ of session.run("go")) {
			// the first durable event
		}
		const meta = readProfile(dir, "s1");
		expect(meta.kind).toBe("ok");
		if (meta.kind === "ok") {
			expect(meta.profile.revision).toBe(1);
			expect(meta.profile.modelId).toBe("faux-y");
		}
	});

	it("a CORRUPT sidecar is BLOCKED — named, never treated as absent", async () => {
		const dir = freshDir();
		const store = new SessionStore(dir);
		await store.append("s2", "r1", { seq: 0, type: "user_input", content: "go" } as never);
		await store.closeAll();
		writeFileSync(profilePath(dir, "s2"), "{ this is not json");
		const agent = createAgent({ model: "faux-y", store: new SessionStore(dir), tools: [], adapter: DONE });
		await expect(agent.session({ id: "s2" })).rejects.toThrow(/profile.*unreadable|unreadable.*profile/i);
	});

	it("an ABSENT sidecar beside scoped envelopes is a BLOCKED integrity case", async () => {
		const dir = freshDir();
		const store = new SessionStore(dir);
		await store.append("s3", "r1", { seq: 0, type: "user_input", content: "go" } as never);
		await store.append("s3", "r1", {
			seq: 1,
			type: "stop",
			reason: "end_turn",
			continuation: { scope: { providerId: "anthropic", apiId: "anthropic-messages", modelId: "m" }, entries: [] },
		} as never);
		await store.closeAll();
		const agent = createAgent({ model: "faux-y", store: new SessionStore(dir), tools: [], adapter: DONE });
		await expect(agent.session({ id: "s3" })).rejects.toThrow(/integrity|missing/i);
	});

	it("a plain legacy log opens with NO sidecar written at open", async () => {
		const dir = freshDir();
		const store = new SessionStore(dir);
		await store.append("s4", "r1", { seq: 0, type: "user_input", content: "go" } as never);
		await store.append("s4", "r1", { seq: 1, type: "stop", reason: "end_turn" } as never);
		await store.closeAll();
		const agent = createAgent({ model: "faux-y", store: new SessionStore(dir), tools: [], adapter: DONE });
		const session = await agent.session({ id: "s4" });
		expect(session).toBeDefined();
		expect(readProfile(dir, "s4").kind, "generation absence is not drift, and not an eager write").toBe("absent");
	});
});

describe("XP-1 — the model is part of the binding (re-ruled by the owner, 2026-09-21, on review)", () => {
	it("the SAME model: nothing moved, so the record stands and no revision is written", async () => {
		const dir = freshDir();
		const store = new SessionStore(dir);
		await store.append("s5", "r1", { seq: 0, type: "user_input", content: "hi" } as never);
		await store.append("s5", "r1", { seq: 1, type: "stop", reason: "end_turn" } as never);
		await store.closeAll();
		writeProfile(dir, "s5", buildProfile({ revision: 3, modelId: "recorded-x", provider: null, registry: new ToolRegistry() }));
		const agent = createAgent({ model: "recorded-x", store: new SessionStore(dir), tools: [], adapter: DONE });
		const session = await agent.session({ id: "s5" });
		expect(session.model, "the row and the request agree").toBe("recorded-x");
		const meta = readProfile(dir, "s5");
		expect(meta.kind === "ok" && meta.profile.revision, "nothing moved, nothing rewritten").toBe(3);
		expect(session.driftAcknowledgement).toBeNull();
	});

	it("a DIFFERENT model, both bindings unscoped: the CURRENT configuration wins, durably, and says so", async () => {
		const dir = freshDir();
		const store = new SessionStore(dir);
		await store.append("s5b", "r1", { seq: 0, type: "user_input", content: "hi" } as never);
		await store.append("s5b", "r1", { seq: 1, type: "stop", reason: "end_turn" } as never);
		await store.closeAll();
		writeProfile(dir, "s5b", buildProfile({ revision: 3, modelId: "recorded-x", provider: null, registry: new ToolRegistry() }));
		const agent = createAgent({ model: "process-default-y", store: new SessionStore(dir), tools: [], adapter: DONE });
		const session = await agent.session({ id: "s5b" });
		expect(session.model, "the configuration is the authority").toBe("process-default-y");
		const meta = readProfile(dir, "s5b");
		expect(meta.kind === "ok" && meta.profile.revision, "recorded as the next revision").toBe(4);
		expect(session.driftAcknowledgement?.reasons.join("; "), "and it names what moved").toMatch(/recorded model is recorded-x/);
	});

	it("a CHANGED BINDING never blocks: the current binding wins, records revision N+1, and says so", async () => {
		const dir = freshDir();
		const store = new SessionStore(dir);
		await store.append("s6", "r1", { seq: 0, type: "user_input", content: "hi" } as never);
		await store.closeAll();
		writeProfile(
			dir,
			"s6",
			buildProfile({
				revision: 2,
				modelId: "deepseek-v4-flash",
				provider: { providerId: "deepseek", apiId: "openai-chat", modelId: "deepseek-v4-flash" },
				registry: new ToolRegistry(),
			}),
		);
		const agent = createAgent({ model: "faux-y", store: new SessionStore(dir), tools: [], adapter: DONE });
		// the owner's ruling of 2026-09-21: no acknowledgement, no flag, no
		// refusal — the person may simply have switched models. (RED pre-patch:
		// this open threw, and the refusal took the whole REPL down with it.)
		const session = await agent.session({ id: "s6" });
		expect(session.model, "the CURRENT binding runs").toBe("faux-y");
		const meta = readProfile(dir, "s6");
		expect(meta.kind === "ok" && meta.profile.revision, "the change is durable history").toBe(3);
		expect(session.driftAcknowledgement?.reasons[0], "and the session names what changed").toMatch(/deepseek/);
	});
});

describe("XP-1 — /model records the next revision durably", () => {
	it("setModelBinding writes revision N+1 with the new model and reasoning", async () => {
		const dir = freshDir();
		const agent = createAgent({ model: "faux-y", store: new SessionStore(dir), tools: [], adapter: DONE });
		const session = await agent.session({ id: "s7" });
		// DC-60: revision 1 lands with the first durable event
		for await (const _ of session.run("go")) {
			// the first turn
		}
		session.setModelBinding({ adapter: DONE, model: "switched-z", reasoning: { thinking: "default", effort: "max" } });
		const meta = readProfile(dir, "s7");
		expect(meta.kind).toBe("ok");
		if (meta.kind === "ok") {
			expect(meta.profile.revision).toBe(2);
			expect(meta.profile.modelId).toBe("switched-z");
			expect(meta.profile.reasoning.effort).toBe("max");
		}
		expect(session.model).toBe("switched-z");
	});
});
