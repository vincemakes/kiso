/**
 * ADR-0064 A2 — leases: the work-log rules, reconciliation after a crash at
 * every step, and the context compiler (A2 spec § 5, § 7, § 4.4 invariant 3).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@vincemakes/kiso-core";
import { SessionStore } from "@vincemakes/kiso-runtime";
import { writeBootstrap } from "@vincemakes/kiso-runtime/lease";
import { describe, expect, it } from "vitest";
import { compileContext, snapshotHead, TRUNCATED_MARKER } from "../src/compile.js";
import { bootstrapDigest, reconcileLease } from "../src/lease.js";
import { WorkLedger, WorkRefusedError } from "../src/ledger.js";
import { MemoryLogBackend } from "../src/memory-log.js";
import { reduceWork } from "../src/reducer.js";
import { crit, DIGEST, ev, lines, prep } from "./helpers.js";

const opened = (leaseId = "L1", sessionId = "s1", sourceWorkRevision = 0) => ({ type: "session_lease_opened", leaseId, sessionId, sourceWorkRevision });
const attached = (leaseId = "L1", digest = DIGEST) => ({ type: "session_lease_attached", leaseId, bootstrapSeq: 0, bootstrapDigest: digest });
const released = (leaseId = "L1", sessionId = "s1", handoff?: string) => ({ type: "session_lease_released", leaseId, sessionId, result: "handoff", finalSessionSeq: 9, ...(handoff ? { handoff } : {}) });
const rules = (l: ReturnType<typeof lines>) => reduceWork(l).problems.map((p) => p.rule);

describe("lease rules in the work log", () => {
	it("one lease at a time; attach and release name it; attach once, at seq 0", () => {
		expect(rules(lines(opened(), attached(), released()))).toEqual([]);
		expect(rules(lines(opened(), opened("L2")))).toEqual(["lease L1 is still opened"]);
		expect(rules(lines(opened(), attached("L2")))).toEqual(["attach of L2, not the open lease"]);
		expect(rules(lines(opened(), attached(), attached()))).toEqual(["lease L1 is already attached"]);
		expect(rules(lines(opened(), { ...attached(), bootstrapSeq: 3 }))).toEqual(["a bootstrap is a session's first event (seq 0)"]);
		expect(rules(lines(opened(), released("L1", "other")))).toEqual(["release of L1, not the open lease"]);
		expect(rules(lines(opened("L1", "s1", 1)))).toEqual(["sourceWorkRevision is not an observed revision"]);
	});

	it("a lease open when the work ends can still be released; nothing else follows", () => {
		expect(rules(lines(opened(), attached(), { type: "cancelled", reason: "x" }, released()))).toEqual([]);
		expect(rules(lines({ type: "cancelled", reason: "x" }, opened()))).toEqual(["event after cancelled"]);
	});

	it("the last released handoff is carried; a handoff over 4 KiB is malformed", () => {
		expect(reduceWork(lines(opened(), attached(), released("L1", "s1", "next: run the tests"))).commitment.lastHandoff).toBe("next: run the tests");
		expect(() => reduceWork(lines(opened(), attached(), released("L1", "s1", "x".repeat(4097))))).toThrow(/malformed session_lease_released/);
	});
});

describe("reconcileLease: every durable state", () => {
	const boot = (leaseId: string, projection = "P") => [{ seq: 0, type: "context_bootstrap", meta: { leaseId }, projection }] as unknown as Event[];
	const at = (events: unknown[], sessionEvents: Event[], o: { liveOwner?: boolean; recoverableRun?: boolean } = {}) =>
		reconcileLease({ commitment: reduceWork(lines(...events)).commitment, sessionEvents, liveOwner: o.liveOwner ?? false, recoverableRun: o.recoverableRun ?? false });

	it("no lease; a live owner", () => {
		expect(at([], [])).toEqual({ decision: "no-lease" });
		expect(at([opened(), attached()], boot("L1"), { liveOwner: true }).decision).toBe("none");
	});

	it("opened, no bootstrap → retry; opened + its bootstrap → attach with that block's digest", () => {
		expect(at([opened()], [])).toEqual({ decision: "retry-bootstrap" });
		expect(at([opened()], boot("L1", "BYTES"))).toEqual({ decision: "attach", bootstrapDigest: bootstrapDigest("BYTES") });
	});

	it("attached and settled → release-stale; a recoverable run or an uncertain effect here → resume", () => {
		const d = bootstrapDigest("P");
		expect(at([opened(), attached("L1", d)], boot("L1"))).toEqual({ decision: "release-stale" });
		expect(at([opened(), attached("L1", d)], boot("L1"), { recoverableRun: true })).toEqual({ decision: "resume-session" });
		const uncertain = [opened(), attached("L1", d), prep("f", 2), { type: "effect_dispatching", effectId: "f", attempt: 1, execution: { sessionId: "s1", executionId: "ex-1" } }];
		expect(at(uncertain, boot("L1"))).toEqual({ decision: "resume-session" });
	});

	it("found by leaseId, never by position; a digest mismatch or a lost bootstrap is corruption", () => {
		expect(at([opened()], boot("L9")).decision).toBe("corrupt");
		expect(at([opened(), attached("L1", bootstrapDigest("P"))], boot("L1", "OTHER")).decision).toBe("corrupt");
		expect(at([opened()], [{ seq: 0, type: "user_input", content: "hi" }] as unknown as Event[]).decision).toBe("corrupt");
	});
});

describe("the context compiler", () => {
	const commitment = reduceWork(lines(crit("u", "user"), crit("a", "agent"), ev("e1", "u"), prep("f", 3))).commitment;

	it("invariant 3: opens with the revision it snapshots, and never reads as current", () => {
		const { projection } = compileContext({ commitment, sources: [{ kind: "work-state" }] });
		expect(projection.split("\n")[0]).toBe(snapshotHead(commitment.revision));
		expect(projection).toContain(`Status at revision ${commitment.revision}`);
		expect(projection).not.toMatch(/\bcurrent (state|status) is\b/i);
	});

	it("is deterministic: the same inputs give the same bytes and digest", () => {
		const a = compileContext({ commitment, sources: [{ kind: "work-state" }, { kind: "handoff" }, { kind: "recent-evidence" }] });
		const b = compileContext({ commitment: structuredClone(commitment), sources: [{ kind: "work-state" }, { kind: "handoff" }, { kind: "recent-evidence" }] });
		expect(a).toEqual(b);
		expect(a.sourceRevisions).toEqual({ work: "4", "work-state": "4", handoff: "4", "recent-evidence": "4" });
	});

	it("labels authority: the person's criteria carry their quoted words", () => {
		const { projection } = compileContext({ commitment, sources: [{ kind: "work-state" }] });
		expect(projection).toContain("Acceptance set by the person (1/1 required met)");
		expect(projection).toContain('(the person\'s words: "x")');
		expect(projection).toContain("Acceptance set by the agent (0/1 required met)");
	});

	it("cuts an over-budget source at a line, marks it and names it", () => {
		const big = { "consumer:notes": () => ({ text: Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"), revision: "n1" }) };
		const out = compileContext({ commitment, sources: [{ kind: "consumer", name: "notes" }], renderers: big, budgets: { "consumer:notes": 60 } });
		const body = out.projection.split("## consumer:notes\n")[1]!;
		expect(Buffer.byteLength(body)).toBeLessThanOrEqual(60);
		expect(body.endsWith(TRUNCATED_MARKER)).toBe(true);
		expect(body.split("\n").slice(0, -1).every((l) => /^line \d+$/.test(l))).toBe(true);
		expect(out.truncated).toEqual(["consumer:notes"]);
		expect(out.sourceRevisions["consumer:notes"]).toBe("n1");
	});

	it("a source without a renderer is an error, never skipped", () => {
		expect(() => compileContext({ commitment, sources: [{ kind: "actor-memory" }] })).toThrow(/no renderer for context source actor-memory/);
	});
});

describe("openLease, end to end on a real session store", () => {
	it("opened → bootstrap at seq 0 of the session → attached with its digest; release carries the handoff", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-actor-lease-")));
		const w = await WorkLedger.create(new MemoryLogBackend(), { actorId: "act", objective: "ship", workId: "w1" });
		await w.addAcceptance({ text: "tests pass", authority: "agent", required: true });
		const { leaseId, digest } = await w.openLease({ store, sessionId: "s1", sources: [{ kind: "work-state" }, { kind: "handoff" }], leaseId: "L1" });
		const first = store.load("s1")[0]!.event;
		expect(first).toMatchObject({ seq: 0, type: "context_bootstrap", meta: { leaseId: "L1", workId: "w1" } });
		expect(bootstrapDigest((first as { projection: string }).projection)).toBe(digest);
		expect(w.view().commitment.lease).toMatchObject({ leaseId, state: "attached", sourceWorkRevision: 1, bootstrapDigest: digest });
		expect((first as { projection: string }).projection.split("\n")[0]).toBe(snapshotHead(1));
		await w.releaseLease({ result: "handoff", finalSessionSeq: 0, handoff: "next: CI" });
		expect(w.view().commitment.lease).toBeUndefined();
		expect(w.view().commitment.lastHandoff).toBe("next: CI");
	});

	it("the A2 contract: a session a lease creates holds exactly one bootstrap, before anything else", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-actor-lease-")));
		const w = await WorkLedger.create(new MemoryLogBackend(), { actorId: "act", objective: "ship", workId: "w1" });
		await w.openLease({ store, sessionId: "s1", sources: [{ kind: "work-state" }], leaseId: "L1" });
		const events = store.load("s1").map((r) => r.event);
		expect(events.map((e) => e.type)).toEqual(["context_bootstrap"]);
		expect(events[0]!.seq).toBe(0);
	});

	it("a second lease on a session that already has a bootstrap is refused by the door, after `opened`", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-actor-lease-")));
		await writeBootstrap(store, "s1", { meta: { leaseId: "old" }, projection: "old" });
		const w = await WorkLedger.create(new MemoryLogBackend(), { actorId: "act", objective: "ship" });
		await expect(w.openLease({ store, sessionId: "s1", sources: [{ kind: "work-state" }], leaseId: "L1" })).rejects.toThrow(/already has events/);
		const decision = reconcileLease({ commitment: w.view().commitment, sessionEvents: store.load("s1").map((r) => r.event), liveOwner: false, recoverableRun: false });
		expect(decision.decision).toBe("corrupt");
	});

	it("release with no open lease is refused", async () => {
		const w = await WorkLedger.create(new MemoryLogBackend(), { actorId: "act", objective: "ship" });
		await expect(w.releaseLease({ result: "abandoned", finalSessionSeq: 0 })).rejects.toBeInstanceOf(WorkRefusedError);
	});
});
