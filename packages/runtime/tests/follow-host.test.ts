/**
 * ADR-0062 Amendment 2 (owner 2026-11-20, a named reversal of "a Work keeps the tool table it was created with"): a Work
 * follows the host that opens it. The host says whether its table has the sessions tools (`sessionsTools`); the sidecar's
 * mark and the next profile revision are written only once the Work's single-writer lock is held (the first durable
 * event), so a refused open writes nothing, and a Work whose table already matches is not touched.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { defineTool, type KisoExtension } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { hasSessionsTools, markSessionsTools, readProfile } from "../src/internal.js";
import { forkSession } from "../src/fork.js";

const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const sessionsExt: KisoExtension = {
	name: "sessions",
	tools: [defineTool({ name: "list_sessions", description: "list", parameters: { type: "object", properties: {} }, execute: async () => ({ content: "none", isError: false as const }) })],
};
const stores: SessionStore[] = [];
const mk = (root: string, sessionsTools: boolean | undefined) =>
	createAgent({
		model: "m",
		store: (stores.push(new SessionStore(root)), stores.at(-1)!),
		systemPrompt: "s",
		tools: [],
		adapter: createFauxProvider([say("one"), say("two"), say("three")] as never),
		...(sessionsTools === true ? { extensions: [sessionsExt] } : {}),
		...(sessionsTools !== undefined ? { sessionsTools } : {}),
	});
const turn = async (agent: ReturnType<typeof mk>, id: string, text: string) => {
	const s = await agent.session({ id });
	for await (const _ of s.run(text)) void _;
	stores.pop()!.close(id); // the host lets go: its lock is released, as a terminal that exits does
	return s;
};
const names = (root: string, id: string): string[] => {
	const p = readProfile(root, id);
	return p.kind === "ok" ? p.profile.tools.map((t) => t.name) : [];
};
// what a host's table decides: the mark and the profile (the summary tenant moves with every run and is not it)
const decided = (root: string, id: string): string => JSON.stringify([hasSessionsTools(root, id), readProfile(root, id)]);
const rev = (root: string, id: string): number => {
	const p = readProfile(root, id);
	return p.kind === "ok" ? p.profile.revision : 0;
};

describe("a Work follows the host that opens it", () => {
	it("a terminal-born Work opened by a host with the tools gains them: mark and a revision, after the first event", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-fh-"));
		await turn(mk(root, false), "w", "one");
		expect([hasSessionsTools(root, "w"), rev(root, "w"), names(root, "w")]).toEqual([false, 1, []]);
		const s = await mk(root, true).session({ id: "w" });
		expect([hasSessionsTools(root, "w"), rev(root, "w")], "opening alone writes nothing").toEqual([false, 1]);
		for await (const _ of s.run("two")) void _;
		stores.pop()!.close("w");
		expect([hasSessionsTools(root, "w"), rev(root, "w"), names(root, "w")]).toEqual([true, 2, ["list_sessions"]]);
	});

	it("and drops them when a host without them opens it: unmarked, the next revision, monotone", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-fh-"));
		await turn(mk(root, true), "w", "one");
		expect([hasSessionsTools(root, "w"), rev(root, "w")]).toEqual([true, 1]);
		await turn(mk(root, false), "w", "two");
		expect([hasSessionsTools(root, "w"), rev(root, "w"), names(root, "w")]).toEqual([false, 2, []]);
		await turn(mk(root, true), "w", "three");
		expect([hasSessionsTools(root, "w"), rev(root, "w"), names(root, "w")]).toEqual([true, 3, ["list_sessions"]]);
	});

	it("a new Work is marked with its revision 1, no second revision; a table that already matches writes nothing", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-fh-"));
		await turn(mk(root, true), "w", "one");
		expect([hasSessionsTools(root, "w"), rev(root, "w")]).toEqual([true, 1]);
		const before = decided(root, "w");
		await turn(mk(root, true), "w", "two");
		expect(decided(root, "w"), "the mark and the profile are what they were").toBe(before);
	});

	it("a host that does not say (an SDK caller) leaves the mark and the revisions alone", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-fh-"));
		await turn(mk(root, undefined), "w", "one");
		markSessionsTools(root, "w");
		const before = decided(root, "w");
		await turn(mk(root, undefined), "w", "two");
		expect(decided(root, "w")).toBe(before);
	});

	it("a refused open writes nothing: the lock is held by a live writer, the sidecar is untouched", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-fh-"));
		await turn(mk(root, false), "w", "one");
		const before = decided(root, "w");
		writeFileSync(join(root, "w.lock"), JSON.stringify({ pid: process.ppid, token: "other-host" }));
		const s = await mk(root, true).session({ id: "w" });
		await expect((async () => { for await (const _ of s.run("two")) void _; })()).rejects.toThrow(/locked by another writer/);
		expect(decided(root, "w"), "nothing was written").toBe(before);
		expect(hasSessionsTools(root, "w")).toBe(false);
	}, 60_000);

	it("a fork carries the mark and the revision it was forked at; opened by the other host it goes on from there, the parent untouched", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-fh-"));
		await turn(mk(root, true), "w", "one");
		await turn(mk(root, false), "w", "two");
		await turn(mk(root, true), "w", "three");
		expect([hasSessionsTools(root, "w"), rev(root, "w")], "replayed through two switches: the revisions are 1, 2, 3").toEqual([true, 3]);
		const fork = forkSession(root, "w").id;
		expect([hasSessionsTools(root, fork), rev(root, fork), names(root, fork)], "the fork is the Work as it was").toEqual([true, 3, ["list_sessions"]]);
		await turn(mk(root, false), fork, "four");
		expect([hasSessionsTools(root, fork), rev(root, fork), names(root, fork)], "the other host drops them: revision 4 of the fork").toEqual([false, 4, []]);
		expect([hasSessionsTools(root, "w"), rev(root, "w")], "the parent is untouched").toEqual([true, 3]);
	});
});
