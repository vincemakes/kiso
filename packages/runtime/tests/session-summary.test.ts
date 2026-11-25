/**
 * The 0.40.0 dogfood (item 2) — the session list reads a SUMMARY from the
 * sidecar instead of the log. Measured on the owner's machine: 118
 * sessions, 584 MB of logs, ≈ 8.3 s to list; from the sidecars, ≈ 3.5 ms.
 *
 * What must hold for that to be safe:
 *   the summary tenant never disturbs the profile tenant (byte identity);
 *   a sidecar holding only a summary never BLOCKS a session from opening;
 *   a run writes its row at its start (open) and its end (the outcome);
 *   the one-time migration reads each legacy log once, never throws the
 *   list on a log it cannot read, and resumes after a crash;
 *   once it is done, the list never opens a log again.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "../src/index.js";
import { buildProfile, profilePath, readProfile, readSummary, writeProfile, writeSummary } from "../src/profile.js";
import { listSessionSidecars, migrateSummaries, SUMMARY_MIGRATION_MARKER, summaryMigrationPending, type SessionSummary } from "../src/session-summary.js";
import { ToolRegistry } from "@vincemakes/kiso-core";

const dir = () => mkdtempSync(join(tmpdir(), "kiso-summary-"));
const SUMMARY: SessionSummary = { title: "t", turns: 1, updatedAt: 5, state: "completed", uncertain: 0, asks: 0, workspaceUnknown: false, source: "run" };

async function legacyLog(root: string, id: string, turns: string[]): Promise<void> {
	const store = new SessionStore(root);
	let seq = 0;
	for (const t of turns) {
		await store.append(id, "r1", { seq: seq++, type: "user_input", content: t } as never);
		await store.append(id, "r1", { seq: seq++, type: "stop", reason: "end_turn" } as never);
	}
	await store.append(id, "r1", { seq: seq++, type: "terminal", outcome: { kind: "completed" } } as never);
	await store.closeAll();
}

describe("0.40.0 dogfood — the sidecar's two tenants", () => {
	it("a summary write leaves the profile tenant BYTE-identical, and a profile write keeps the summary", () => {
		const root = dir();
		writeProfile(root, "s", buildProfile({ revision: 1, modelId: "m", provider: null, registry: new ToolRegistry(), workspace: "/w" }));
		const profileBytes = () => JSON.stringify(JSON.parse(readFileSync(profilePath(root, "s"), "utf8")).profile);
		const before = profileBytes();
		writeSummary(root, "s", SUMMARY);
		expect(profileBytes()).toBe(before);
		writeProfile(root, "s", buildProfile({ revision: 2, modelId: "m2", provider: null, registry: new ToolRegistry(), workspace: "/w" }));
		expect(readSummary(root, "s")).toEqual(SUMMARY);
	});

	it("a sidecar holding ONLY a summary reads as no profile — absent, never corrupt, so the session still opens", async () => {
		const root = dir();
		await legacyLog(root, "legacy", ["hello"]);
		writeSummary(root, "legacy", SUMMARY);
		expect(readProfile(root, "legacy").kind).toBe("absent");
		const s = await createAgent({ model: "faux", store: new SessionStore(root), tools: [], adapter: createFauxProvider([]) }).session({ id: "legacy" });
		expect(s.id).toBe("legacy");
	});
});

describe("0.40.0 dogfood — a run writes its row", () => {
	it("at its end: the outcome, the turns, the title", async () => {
		const root = dir();
		const store = new SessionStore(root);
		const agent = createAgent({ model: "faux", store, tools: [], adapter: createFauxProvider([{ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] }]), workspace: "/w" });
		const session = await agent.session({ id: "live" });
		for await (const _ of session.run("fix the parser")) {
			/* drain */
		}
		await store.closeAll();
		const s = readSummary(root, "live");
		expect(s).toMatchObject({ title: "fix the parser", turns: 1, state: "completed", source: "run", workspaceUnknown: false });
	});
});

describe("0.40.0 dogfood — the one-time migration", () => {
	it("summarises each legacy log once, marks itself done, and the list then reads sidecars only", async () => {
		const root = dir();
		await legacyLog(root, "a", ["first thing"]);
		await legacyLog(root, "b", ["hi", "the real work"]);
		expect(summaryMigrationPending(root)).toBe(true);
		const loaded: string[] = [];
		const store = new SessionStore(root);
		expect(migrateSummaries(root, (id) => (loaded.push(id), store.load(id)))).toBe(2);
		expect(loaded.sort()).toEqual(["a", "b"]);
		expect(summaryMigrationPending(root)).toBe(false);
		expect(readSummary(root, "b")).toMatchObject({ title: "the real work", turns: 2, state: "completed", source: "migration", workspaceUnknown: true });
		// the list never opens a log: make every log unreadable and it still lists
		for (const id of ["a", "b"]) chmodSync(join(root, `${id}.jsonl`), 0o000);
		try {
			expect(listSessionSidecars(root).map((l) => [l.id, l.summary?.title])).toEqual([
				["a", "first thing"],
				["b", "the real work"],
			]);
		} finally {
			for (const id of ["a", "b"]) chmodSync(join(root, `${id}.jsonl`), 0o600);
		}
	});

	it("a log it cannot read gets what CAN be said, and never throws the list", async () => {
		const root = dir();
		await legacyLog(root, "ok", ["fine"]);
		writeFileSync(join(root, "broken.jsonl"), "{ not json\n");
		const store = new SessionStore(root);
		expect(() => migrateSummaries(root, (id) => store.load(id))).not.toThrow();
		expect(readSummary(root, "broken")).toMatchObject({ title: null, turns: null, state: null, source: "migration" });
		expect(readSummary(root, "ok")?.title).toBe("fine");
	});

	it("is resumable: a crash mid-way leaves the done ones done, and the next pass finishes the rest", async () => {
		const root = dir();
		await legacyLog(root, "a", ["one"]);
		await legacyLog(root, "b", ["two"]);
		const store = new SessionStore(root);
		// the first pass dies after one session (the marker never lands)
		expect(() =>
			migrateSummaries(root, (id) => store.load(id), (done) => {
				if (done === 1) throw new Error("killed");
			}),
		).toThrow("killed");
		expect(summaryMigrationPending(root)).toBe(true);
		const firstDone = ["a", "b"].filter((id) => readSummary(root, id) !== null);
		expect(firstDone).toHaveLength(1);
		const again: string[] = [];
		migrateSummaries(root, (id) => (again.push(id), store.load(id)));
		expect(again).toEqual(["a", "b"].filter((id) => !firstDone.includes(id)));
		expect(summaryMigrationPending(root)).toBe(false);
	});

	it("the marker is a dotfile beside the logs — never mistaken for a session", () => {
		expect(SUMMARY_MIGRATION_MARKER.startsWith(".")).toBe(true);
	});
});
