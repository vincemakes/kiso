/**
 * ADR-0064 § 2.2, § 3, § 4 — the reducer: strict reading, acceptance
 * authority and supersession, evidence-bound completion, terminal events,
 * status derivation, purity.
 */
import { describe, expect, it } from "vitest";
import { WorkLogCorruptionError } from "../src/events.js";
import { reduceWork } from "../src/reducer.js";
import { crit, ev, lines, prep } from "./helpers.js";

const rules = (l: ReturnType<typeof lines>) => reduceWork(l).problems.map((p) => `${p.seq}: ${p.rule}`);

describe("strict reading", () => {
	it("an unknown event type, a malformed event, an unknown format, a missing work_created each throw with the seq", () => {
		expect(() => reduceWork(lines({ type: "work_records", records: [] }))).toThrow(WorkLogCorruptionError);
		expect(() => reduceWork(lines({ type: "failed" }))).toThrow(/seq 1: malformed failed/);
		expect(() => reduceWork([{ seq: 0, ts: 0, event: { type: "work_created", format: 2, workId: "w", actorId: "a", objective: "o" } }])).toThrow(/seq 0/);
		expect(() => reduceWork([{ seq: 0, ts: 0, event: { type: "cancelled", reason: "x" } }])).toThrow(/not work_created/);
		expect(() => reduceWork([{ seq: 0, ts: 0, event: { type: "work_created", format: 1, workId: "w", actorId: "a", objective: "o" } }, { seq: 2, ts: 0, event: { type: "cancelled", reason: "x" } }])).toThrow(/seq gap/);
	});

	it("an evidence owner outside session/ and work/ is malformed", () => {
		expect(() => reduceWork(lines(crit("c", "agent"), { type: "evidence_added", evidenceId: "e", criterionIds: ["c"], ref: { log: { owner: "project/p", seq: 1 } } }))).toThrow(/malformed evidence_added/);
	});
});

describe("supersession (ADR-0064 § 4): every cell", () => {
	const table: Array<["user" | "system" | "agent", "user" | "system" | "agent", boolean]> = [
		["user", "user", true],
		["user", "system", true],
		["user", "agent", true],
		["system", "user", false],
		["system", "system", true],
		["system", "agent", true],
		["agent", "user", false],
		["agent", "system", false],
		["agent", "agent", true],
	];
	for (const [source, target, allowed] of table) {
		it(`${source} supersedes ${target}: ${allowed ? "yes" : "no"}`, () => {
			const { commitment, problems } = reduceWork(lines(crit("t", target), crit("s", source, { supersedes: ["t"] })));
			expect(commitment.acceptance.map((c) => c.criterionId)).toEqual(allowed ? ["s"] : ["t", "s"]);
			expect(problems.length).toBe(allowed ? 0 : 1);
		});
	}

	it("a fabricated agent edit cannot remove a user criterion, and still commits at its own authority", () => {
		const { commitment, problems } = reduceWork(lines(crit("u", "user"), crit("a", "agent", { supersedes: ["u"] })));
		expect(commitment.acceptance.map((c) => [c.criterionId, c.authority])).toEqual([
			["u", "user"],
			["a", "agent"],
		]);
		expect(problems).toEqual([{ seq: 2, rule: "supersedes u: agent may not supersede user" }]);
	});

	it("a user criterion needs a quote; a non-user one may not carry one", () => {
		expect(rules(lines({ type: "acceptance_added", criterionId: "u", text: "t", authority: "user", required: true }))).toEqual(["1: a user criterion without a quote"]);
		expect(rules(lines({ type: "acceptance_added", criterionId: "a", text: "t", authority: "agent", required: true, quote: { owner: "session/s", seq: 0, span: "x" } }))).toEqual([
			"1: a quote on a non-user criterion",
		]);
	});
});

describe("evidence-bound completion", () => {
	it("refused with an unevidenced required criterion; allowed once evidenced; reported per authority", () => {
		const base = [crit("u", "user"), crit("a", "agent"), crit("o", "agent", { required: false }), ev("e1", "u")];
		expect(rules(lines(...base, { type: "completed" }))).toEqual(["5: completion with criterion a unevidenced"]);
		const done = reduceWork(lines(...base, ev("e2", "a"), { type: "completed" }));
		expect(done.problems).toEqual([]);
		expect(done.commitment.status).toBe("completed");
		expect(done.commitment.completion).toEqual({ user: { met: 1, required: 1 }, system: { met: 0, required: 0 }, agent: { met: 1, required: 1 } });
	});

	it("refused while an effect is prepared or uncertain", () => {
		expect(rules(lines(prep("f"), { type: "completed" }))).toEqual(["2: completion with effect f prepared"]);
		expect(rules(lines(prep("f"), { type: "effect_dispatching", effectId: "f", attempt: 1 }, { type: "completed" }))).toEqual(["3: completion with effect f uncertain"]);
	});

	it("a superseded criterion no longer needs evidence", () => {
		const { commitment } = reduceWork(lines(crit("a", "agent"), crit("b", "agent", { supersedes: ["a"] }), ev("e", "b"), { type: "completed" }));
		expect(commitment.status).toBe("completed");
	});
});

describe("status and terminal events", () => {
	it("events after a terminal event are problems and change nothing", () => {
		const r = reduceWork(lines({ type: "cancelled", reason: "x" }, { type: "state_changed", to: "waiting", reason: "y" }, crit("a", "agent")));
		expect(r.commitment.status).toBe("cancelled");
		expect(r.commitment.acceptance).toEqual([]);
		expect(r.problems.map((p) => p.seq)).toEqual([2, 3]);
	});

	it("an uncertain effect makes the work needs-human, whatever state_changed said", () => {
		const r = reduceWork(lines({ type: "state_changed", to: "waiting", reason: "ci" }, prep("f"), { type: "effect_dispatching", effectId: "f", attempt: 1 }));
		expect(r.commitment.status).toBe("needs-human");
		expect(reduceWork(lines({ type: "state_changed", to: "waiting", reason: "ci" })).commitment.status).toBe("waiting");
	});

	it("revision is the last committed seq", () => {
		expect(reduceWork(lines(crit("a", "agent"), ev("e", "a"))).commitment.revision).toBe(2);
	});
});

describe("purity", () => {
	it("reducing the same lines twice gives equal views: no state survives a call", () => {
		const l = lines(crit("u", "user"), crit("a", "agent"), crit("b", "agent", { supersedes: ["a"] }), prep("f"), { type: "effect_dispatching", effectId: "f", attempt: 1 }, ev("e", "u"));
		expect(reduceWork(l)).toEqual(reduceWork(structuredClone(l)));
	});
});
