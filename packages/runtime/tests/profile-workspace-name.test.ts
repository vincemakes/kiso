/**
 * 0.40.0 — the profile records WHERE a session started and WHICH config
 * profile named its binding.
 *
 * `workspace` is history: set once, at revision 1, from the root the
 * session started in, and carried by every later revision — never
 * re-derived from whichever process happens to write next. `profileName`
 * is configuration: every revision records the name in force when it was
 * written, and drift never compares it (a renamed profile is a label
 * change, not a different answerer).
 *
 * The round-trip gate is the one the source audit asked to make
 * executable: profiles are rebuilt by FULL REPLACEMENT at three sites, so
 * a field one site forgets to pass is silently dropped. Every declared key
 * is checked at every site.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolRegistry, type Adapter } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { buildProfile, profilePath, readProfile, writeProfile, type ExecutionProfile } from "../src/profile.js";

const DONE: Adapter = {
	stream: async function* () {
		yield { seq: 0, type: "text_delta", text: "ok" } as never;
		yield { seq: 0, type: "stop", reason: "end_turn" } as never;
	},
};

/** Every key ExecutionProfile declares. A key added to the interface and
 *  not here fails the type check below, so this list cannot go stale. */
const DECLARED = ["revision", "at", "modelId", "provider", "profileName", "reasoning", "systemPromptDigest", "tools", "toolManifestDigest", "workspace"] as const;
type Exhaustive = Exclude<keyof ExecutionProfile, (typeof DECLARED)[number]> extends never ? true : false;
const exhaustive: Exhaustive = true;

function profileOf(dir: string, id: string): ExecutionProfile {
	const r = readProfile(dir, id);
	if (r.kind !== "ok") throw new Error(`no profile: ${r.kind}`);
	return r.profile;
}

function keysPresent(p: ExecutionProfile): void {
	expect(exhaustive).toBe(true);
	for (const k of DECLARED) expect(Object.prototype.hasOwnProperty.call(p, k), `the profile dropped "${k}"`).toBe(true);
}

const SCOPE = { providerId: "deepseek", apiId: "openai-chat", modelId: "deepseek-flash" };

describe("0.40.0 — every declared field survives all three writers", () => {
	it("revision 1, revision 2 (setModelBinding) and a drift acknowledgement", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-ws-"));
		// revision 1 — a new session started in /work/a under profile "fast"
		const a = createAgent({ model: "faux-y", store: new SessionStore(dir), tools: [], adapter: DONE, workspace: "/work/a", profileName: "fast" });
		const s1 = await a.session({ id: "s" });
		// DC-60: revision 1 lands with the first durable event, not at open
		for await (const _ of s1.run("go")) {
			// the first turn
		}
		const r1 = profileOf(dir, "s");
		keysPresent(r1);
		expect(r1.revision).toBe(1);
		expect(r1.workspace).toBe("/work/a");
		expect(r1.profileName).toBe("fast");

		// revision 2 — a /model switch to the profile "deep"
		s1.setModelBinding({ adapter: DONE, model: "deepseek-flash", scope: SCOPE, reasoning: { thinking: "default", effort: "high" }, profileName: "deep" });
		const r2 = profileOf(dir, "s");
		keysPresent(r2);
		expect(r2.revision).toBe(2);
		expect(r2.workspace, "history is carried, not re-derived").toBe("/work/a");
		expect(r2.profileName).toBe("deep");
		a.close();

		// revision 3 — another process, started ELSEWHERE, with a DIFFERENT
		// binding: it never blocks (owner-ruled 2026-09-21), the CURRENT
		// configuration is what gets recorded, and the change is named
		const c = createAgent({ model: "faux-z", store: new SessionStore(dir), tools: [], adapter: DONE, workspace: "/somewhere/else", profileName: "local" });
		const s3 = await c.session({ id: "s" });
		const r3 = profileOf(dir, "s");
		keysPresent(r3);
		expect(r3.revision).toBe(3);
		expect(r3.workspace, "an acknowledging process's cwd is not where the session started").toBe("/work/a");
		expect(r3.profileName, "configuration: the current name wins").toBe("local");
		// the owner-ruled reset stays — and the acknowledgement SAYS so
		expect(r3.reasoning).toEqual({ thinking: "default", effort: "default" });
		expect(s3.driftAcknowledgement).toEqual({
			reasons: [expect.stringContaining("deepseek")],
			reasoningReset: { thinking: "default", effort: "high" },
		});
		c.close();
	});

	it("a session that opened without drift has no acknowledgement", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-ws-"));
		const s = await createAgent({ model: "faux-y", store: new SessionStore(dir), tools: [], adapter: DONE }).session({ id: "s" });
		expect(s.driftAcknowledgement).toBeNull();
	});
});

describe("0.40.0 — profileName is never drift", () => {
	it("recorded under name A, same provider and model now named B: re-opens cleanly", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-ws-"));
		const store = new SessionStore(dir);
		await store.append("s", "r1", { seq: 0, type: "user_input", content: "hi" } as never);
		await store.closeAll();
		writeProfile(dir, "s", { ...buildProfile({ revision: 1, modelId: "faux-y", provider: null, profileName: "old-name", registry: new ToolRegistry(), workspace: "/w" }) });
		const agent = createAgent({ model: "faux-y", store: new SessionStore(dir), tools: [], adapter: DONE, profileName: "new-name", workspace: "/w" });
		const session = await agent.session({ id: "s" });
		expect(session.model).toBe("faux-y");
		expect(session.driftAcknowledgement).toBeNull();
		expect(profileOf(dir, "s").revision, "opening wrote nothing").toBe(1);
	});
});

describe("0.40.0 — where a session started is history, and unknown history stays unknown", () => {
	it("a legacy session gets revision 1 at its first request with workspace null — never today's cwd", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-ws-"));
		const store = new SessionStore(dir);
		await store.append("s", "r1", { seq: 0, type: "user_input", content: "hi" } as never);
		await store.append("s", "r1", { seq: 1, type: "stop", reason: "end_turn" } as never);
		await store.append("s", "r1", { seq: 2, type: "terminal", outcome: { kind: "completed" } } as never);
		await store.closeAll();
		const agent = createAgent({ model: "faux-y", store: new SessionStore(dir), tools: [], adapter: DONE, workspace: "/not/where/it/started", profileName: "p" });
		const session = await agent.session({ id: "s" });
		for await (const _ of session.run("again")) {
			/* drain */
		}
		const r1 = profileOf(dir, "s");
		keysPresent(r1);
		expect(r1.revision).toBe(1);
		expect(r1.workspace).toBeNull();
		expect(r1.profileName).toBe("p");
	});

	it("a sidecar written before the field existed reads workspace and profileName as null", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-ws-"));
		const old = { revision: 1, at: "2026-09-01T00:00:00.000Z", modelId: "m", provider: null, reasoning: { thinking: "default", effort: "default" }, systemPromptDigest: "d", tools: [], toolManifestDigest: "t" };
		writeFileSync(profilePath(dir, "s"), `${JSON.stringify({ profile: old })}\n`);
		const p = profileOf(dir, "s");
		expect(p.workspace).toBeNull();
		expect(p.profileName).toBeNull();
	});
});
