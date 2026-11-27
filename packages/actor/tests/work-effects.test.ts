/**
 * ADR-0064 § 3 — effect identity: bound at prepare, write-ahead dispatch,
 * no silent retry, human resolution, and the join with the runtime's execution ledger.
 */
import type { Event } from "@vincemakes/kiso-core";
import { describe, expect, it } from "vitest";
import { actionDigest } from "../src/effects.js";
import { WorkLedger, WorkRefusedError } from "../src/ledger.js";
import { MemoryLogBackend } from "../src/memory-log.js";
import { reduceWork } from "../src/reducer.js";
import { lines, prep } from "./helpers.js";

const dispatch = (effectId: string, attempt = 1) => ({ type: "effect_dispatching", effectId, attempt });
const resolve = (effectId: string, outcome: string, by: string, attempt = 1) => ({ type: "effect_resolved", effectId, attempt, outcome, by });
const status = (l: ReturnType<typeof lines>) => reduceWork(l).commitment.effects.map((e) => `${e.status}@${e.attempt}`);
const rules = (l: ReturnType<typeof lines>) => reduceWork(l).problems.map((p) => p.rule);

describe("effect states", () => {
	it("prepared → dispatching reads uncertain → a receipt is the outcome", () => {
		expect(status(lines(prep("f")))).toEqual(["prepared@1"]);
		expect(status(lines(prep("f"), dispatch("f")))).toEqual(["uncertain@1"]);
		expect(status(lines(prep("f"), dispatch("f"), resolve("f", "succeeded", "receipt")))).toEqual(["succeeded@1"]);
		expect(status(lines(prep("f"), dispatch("f"), resolve("f", "failed", "host")))).toEqual(["failed@1"]);
	});

	it("no silent retry: a second dispatch from uncertain is a problem; after a human rerun, attempt 2 is allowed", () => {
		expect(rules(lines(prep("f"), dispatch("f"), dispatch("f")))).toEqual(["dispatch from uncertain (no silent retry)"]);
		expect(rules(lines(prep("f"), dispatch("f"), dispatch("f", 2)))).toEqual(["dispatch from uncertain (no silent retry)"]);
		const l = lines(prep("f"), dispatch("f"), resolve("f", "rerun", "human"), dispatch("f", 2));
		expect(rules(l)).toEqual([]);
		expect(status(l)).toEqual(["uncertain@2"]);
		expect(rules(lines(prep("f"), dispatch("f"), resolve("f", "rerun", "human"), dispatch("f", 1)))).toEqual(["dispatch attempt 1, expected 2"]);
	});

	it("rerun and abandoned of an uncertain effect only by a human; an outcome never by a human", () => {
		expect(rules(lines(prep("f"), dispatch("f"), resolve("f", "rerun", "host")))).toEqual(["rerun only by a human, only from uncertain"]);
		expect(rules(lines(prep("f"), dispatch("f"), resolve("f", "abandoned", "receipt")))).toEqual(["abandoned from uncertain by receipt"]);
		expect(rules(lines(prep("f"), dispatch("f"), resolve("f", "succeeded", "human")))).toEqual(["succeeded by human: an outcome comes from a receipt or the host"]);
		expect(rules(lines(prep("f"), resolve("f", "rerun", "human")))).toEqual(["rerun only by a human, only from uncertain"]);
		expect(status(lines(prep("f"), dispatch("f"), resolve("f", "abandoned", "human")))).toEqual(["abandoned@1"]);
	});

	it("an undispatched effect may be withdrawn by the host; an outcome needs a dispatch", () => {
		expect(status(lines(prep("f"), resolve("f", "abandoned", "host")))).toEqual(["abandoned@1"]);
		expect(rules(lines(prep("f"), resolve("f", "succeeded", "receipt")))).toEqual(["succeeded from prepared"]);
	});

	it("identity is bound at prepare: this work, an observed revision, a digest", () => {
		expect(rules(lines({ ...prep("f"), workId: "other" }))).toEqual(["effect owned by another work"]);
		expect(rules(lines(prep("f", 1)))).toEqual(["workRevision is not an observed revision"]);
		expect(rules(lines({ ...prep("f"), actionDigest: "abc" }))).toEqual(["actionDigest is not a SHA-256 hex digest"]);
		expect(actionDigest({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(actionDigest({ a: [1, { c: 3, d: 2 }], b: 1 }));
		expect(actionDigest({ a: 1 })).not.toBe(actionDigest({ a: 2 }));
	});
});

describe("the ledger refuses what the reducer would report", () => {
	it("prepare records the revision it observed; a dispatch after a terminal event is refused", async () => {
		const w = await WorkLedger.create(new MemoryLogBackend(), { actorId: "act", objective: "o", workId: "w1" });
		const id = await w.prepareEffect({ action: { to: "x" }, label: "send" });
		expect(w.view().commitment.effects[0]).toMatchObject({ effectId: id, workId: "w1", workRevision: 0, actionDigest: actionDigest({ to: "x" }) });
		await w.cancel("changed my mind");
		await expect(w.dispatchEffect(id)).rejects.toBeInstanceOf(WorkRefusedError);
		expect(w.view().problems).toEqual([]);
	});

	it("no silent retry through the API", async () => {
		const w = await WorkLedger.create(new MemoryLogBackend(), { actorId: "act", objective: "o" });
		const id = await w.prepareEffect({ action: 1, label: "send" });
		await w.dispatchEffect(id);
		await expect(w.dispatchEffect(id)).rejects.toThrow(/no silent retry/);
		await w.resolveEffect(id, "rerun", "human");
		await w.dispatchEffect(id);
		expect(w.view().commitment.effects[0]?.attempt).toBe(2);
	});
});

describe("one execution identity: reconcile from the session's execution ledger", () => {
	const session = (status: "succeeded" | "failed" | "none" | "abandoned"): Event[] =>
		[
			{ seq: 0, type: "user_input", content: "go" },
			{ seq: 1, type: "tool_execution_started", executionId: "ex-1", callId: "c1", name: "send", input: {} },
			...(status === "succeeded" ? [{ seq: 2, type: "tool_execution_succeeded", executionId: "ex-1", callId: "c1", result: { content: "sent", isError: false } }] : []),
			...(status === "failed" ? [{ seq: 2, type: "tool_execution_failed", executionId: "ex-1", callId: "c1", error: "boom", safeToRetry: false }] : []),
			...(status === "abandoned" ? [{ seq: 2, type: "tool_execution_resolved", executionId: "ex-1", callId: "c1", resolution: "abandoned" }] : []),
		] as Event[];

	async function dispatched(sessionId: string) {
		const w = await WorkLedger.create(new MemoryLogBackend(), { actorId: "act", objective: "o" });
		const id = await w.prepareEffect({ action: "x", label: "send" });
		await w.dispatchEffect(id, { sessionId, executionId: "ex-1" });
		return w;
	}

	it("a ledger success resolves the effect by receipt; a ledger uncertain leaves it uncertain", async () => {
		const w = await dispatched("s1");
		expect(await w.reconcileEffects("s1", session("none"))).toBe(0);
		expect(w.view().commitment.effects[0]?.status).toBe("uncertain");
		expect(await w.reconcileEffects("s1", session("succeeded"))).toBe(1);
		expect(w.view().commitment.effects[0]).toMatchObject({ status: "succeeded", receipt: "session/s1#ex-1" });
	});

	it("a failure is an outcome; a human's ruling in the session is a human's here", async () => {
		const f = await dispatched("s1");
		await f.reconcileEffects("s1", session("failed"));
		expect(f.view().commitment.effects[0]?.status).toBe("failed");
		const a = await dispatched("s1");
		await a.reconcileEffects("s1", session("abandoned"));
		expect(a.view().commitment.effects[0]?.status).toBe("abandoned");
	});

	it("another session's executions are ignored", async () => {
		const w = await dispatched("s1");
		expect(await w.reconcileEffects("s2", session("succeeded"))).toBe(0);
		expect(w.view().commitment.effects[0]?.status).toBe("uncertain");
	});
});
