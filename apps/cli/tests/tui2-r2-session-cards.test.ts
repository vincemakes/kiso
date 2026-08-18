/**
 * TUI2-R2 slice ① — the state projection: a session's durable log →
 * {badge, turns, age, note}.
 *
 * The badge is the moat made visible. Every one of its five states is a
 * PURE PROJECTION over facts the durable log already carries — no new
 * event, no new field, no second store. That is the whole design
 * constraint: a badge that needed its own bookkeeping could disagree
 * with the recovery the product actually performs, and a durability
 * claim that disagrees with the recovery is worse than no claim.
 *
 * The fixtures here are written by the REAL runtime writer
 * (SessionStore.append — the same call the running product makes,
 * including its expected-last-seq CAS and its fsync), never
 * hand-authored JSONL. A hand-written fixture proves the projection
 * against a shape the writer might not even produce; these prove it
 * against the shape it does.
 *
 * The five states and the events that make them:
 *   ✓ completed  — the run's terminal event says `completed`
 *   ✗ failed     — the terminal says anything else (error, aborted, …)
 *   ▌ interrupted— there is NO terminal event: the run was cut mid-flight
 *                  and resumes from its durable prefix
 *   ? uncertain  — the execution ledger holds a started-with-no-receipt
 *                  entry; it OVERRIDES ▌ (the spec's one explicit
 *                  override: an interrupted run that also needs a human
 *                  verdict must say the harder thing)
 *   ◌ ask        — a permission request nobody has answered
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "@vincemakes/kiso-runtime";
import type { Event } from "@vincemakes/kiso-core";
import { collectSessionCards, projectSessionCard } from "../src/session-cards.js";
import { sessionNote } from "@vincemakes/kiso-tui";

/** The REAL writer, on a throwaway root. */
function store(): SessionStore {
	return new SessionStore(mkdtempSync(join(tmpdir(), "kiso-r2-cards-")));
}

/** Write a session through the real writer. `runs` is a list of runs,
 *  each a list of events WITHOUT their seq — the seq is the store's own
 *  CAS input and is assigned here in one ascending sequence, exactly as
 *  the running product assigns it. */
async function writeSession(s: SessionStore, id: string, runs: { runId: string; events: Omit<Event, "seq">[] }[]): Promise<void> {
	let seq = 0;
	for (const run of runs) {
		for (const ev of run.events) {
			await s.append(id, run.runId, { ...ev, seq } as Event);
			seq += 1;
		}
	}
}

const userInput = (content: string): Omit<Event, "seq"> => ({ type: "user_input", content }) as Omit<Event, "seq">;
const stop = (): Omit<Event, "seq"> => ({ type: "stop", reason: "end_turn" }) as Omit<Event, "seq">;
const terminal = (outcome: Record<string, unknown>): Omit<Event, "seq"> => ({ type: "terminal", outcome }) as unknown as Omit<Event, "seq">;
const started = (executionId: string): Omit<Event, "seq"> =>
	({ type: "tool_execution_started", executionId, callId: `c-${executionId}`, name: "shell", input: { command: "npm test" } }) as Omit<Event, "seq">;
const succeeded = (executionId: string): Omit<Event, "seq"> =>
	({ type: "tool_execution_succeeded", executionId, callId: `c-${executionId}`, result: { content: "ok", isError: false } }) as Omit<Event, "seq">;
const requested = (decisionId: string): Omit<Event, "seq"> =>
	({ type: "permission_requested", decisionId, callId: `c-${decisionId}`, name: "shell", input: { command: "rm -rf build" } }) as Omit<Event, "seq">;
const decided = (decisionId: string): Omit<Event, "seq"> =>
	({ type: "permission_decided", decisionId, decision: "approved" }) as Omit<Event, "seq">;

/** The projection's input, straight off the real writer's file. */
function cardOf(s: SessionStore, id: string, asks = 0) {
	const records = s.load(id);
	return projectSessionCard({ id, updatedAt: records.at(-1)?.ts ?? 0, records, asks });
}

describe("TUI2-R2 ① — the badge projection over sessions the real writer wrote", () => {
	it("a terminal `completed` projects ✓ — completed clean", async () => {
		const s = store();
		await writeSession(s, "fix-auth-race", [
			{ runId: "r1", events: [userInput("fix the race"), started("e1"), succeeded("e1"), stop(), terminal({ kind: "completed" })] },
		]);
		const card = cardOf(s, "fix-auth-race");
		expect(card.badge).toBe("completed");
		expect(card.turns).toBe(1);
		expect(card.uncertain).toBe(0);
		expect(sessionNote(card)).toBe("completed clean");
	});

	it("a terminal `error` projects ✗, and so does `aborted` — the honest note names the outcome", async () => {
		const s = store();
		await writeSession(s, "broke", [
			{ runId: "r1", events: [userInput("go"), terminal({ kind: "error", error: { code: "api_5xx", retryable: false, message: "boom" } })] },
		]);
		await writeSession(s, "stopped", [{ runId: "r1", events: [userInput("go"), terminal({ kind: "aborted", by: "user" })] }]);
		expect(cardOf(s, "broke").badge).toBe("failed");
		expect(sessionNote(cardOf(s, "broke"))).toBe("failed");
		expect(cardOf(s, "stopped").badge).toBe("failed");
		expect(sessionNote(cardOf(s, "stopped"))).toBe("aborted");
	});

	it("NO terminal event projects ▌ — interrupted mid-run, and the note promises the exact resume", async () => {
		const s = store();
		await writeSession(s, "tui2-dogfood", [
			{ runId: "r1", events: [userInput("one"), stop(), terminal({ kind: "completed" })] },
			{ runId: "r2", events: [userInput("two"), started("e2"), succeeded("e2")] },
		]);
		const card = cardOf(s, "tui2-dogfood");
		expect(card.badge).toBe("interrupted");
		expect(card.turns).toBe(2); // both user inputs count — the turn is the human's unit
		expect(sessionNote(card)).toBe("interrupted mid-run — resumes exactly");
	});

	it("an uncertain ledger entry projects ? and OVERRIDES ▌ — the interrupted run that also needs a verdict says the harder thing", async () => {
		const s = store();
		// started with NO receipt: the crash window — the ledger's own
		// "uncertain". The run has no terminal either, so this fixture is
		// exactly the override case.
		await writeSession(s, "bench-refactor", [{ runId: "r1", events: [userInput("refactor"), started("e9")] }]);
		const card = cardOf(s, "bench-refactor");
		expect(card.badge).toBe("uncertain");
		expect(card.uncertain).toBe(1);
		expect(sessionNote(card)).toBe("1 uncertain — needs your verdict");
	});

	it("a pending ask projects ◌ — and an ANSWERED one does not", async () => {
		const s = store();
		await writeSession(s, "release-notes", [{ runId: "r1", events: [userInput("cut the notes"), requested("d1")] }]);
		await writeSession(s, "answered", [{ runId: "r1", events: [userInput("go"), requested("d2"), decided("d2"), stop(), terminal({ kind: "completed" })] }]);
		// the ask count is the runtime's own pendingApprovals() — the
		// projection consumes it, it never re-derives it
		const pending = cardOf(s, "release-notes", 1);
		expect(pending.badge).toBe("ask");
		expect(sessionNote(pending)).toBe("1 ask pending");
		expect(cardOf(s, "answered", 0).badge).toBe("completed");
	});

	it("the age rides updatedAt — the last record's stamp, never a file mtime", async () => {
		const s = store();
		const before = Date.now();
		await writeSession(s, "aged", [{ runId: "r1", events: [userInput("go"), stop(), terminal({ kind: "completed" })] }]);
		const card = cardOf(s, "aged");
		expect(card.updatedAt).toBeGreaterThanOrEqual(before);
		expect(card.updatedAt).toBeLessThanOrEqual(Date.now());
	});

	it("collectSessionCards walks the store's listing and asks the runtime for the pending approvals — newest first", async () => {
		const s = store();
		await writeSession(s, "older", [{ runId: "r1", events: [userInput("a"), stop(), terminal({ kind: "completed" })] }]);
		await new Promise((r) => setTimeout(r, 5));
		await writeSession(s, "newer", [{ runId: "r1", events: [userInput("b"), requested("d1")] }]);
		const asked: string[] = [];
		const cards = await collectSessionCards(
			{
				sessions: () => s.list(),
				session: async ({ id }: { id: string }) => {
					asked.push(id);
					return { pendingApprovals: () => (id === "newer" ? [{ decisionId: "d1" }] : []) };
				},
			},
			(id) => s.load(id),
		);
		expect(cards.map((c) => c.id)).toEqual(["newer", "older"]); // newest first
		expect(cards[0]!.badge).toBe("ask");
		expect(cards[1]!.badge).toBe("completed");
		expect(asked.sort()).toEqual(["newer", "older"]); // the runtime accessor, once per session
	});
});
