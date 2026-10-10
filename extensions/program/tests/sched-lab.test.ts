/** A2 scheduler lab: correctness first, then speed. Prints the table; asserts the claims the report makes. */
import { describe, expect, it } from "vitest";
import { runScenario, SCENARIOS, type Outcome } from "./sched-lab.js";

const L = 12;
describe("scheduler lab (real concurrency, no model)", () => {
	const all: Record<string, Outcome[]> = {};
	it("runs every scenario under every executor", async () => {
		for (const sc of SCENARIOS) all[sc.name] = await runScenario(sc, L);
		const rows = Object.values(all).flat();
		console.log(["scenario".padEnd(66), "exec".padEnd(13), "correct", "wall ms", "calls", "extra", "refused", "lost", "maxInfl"].join(" | "));
		for (const r of rows) console.log([r.scenario.padEnd(66), r.exec.padEnd(13), String(r.stateOk).padEnd(7), String(r.wallMs).padStart(7), String(r.calls).padStart(5), String(r.extraCalls).padStart(5), String(r.refused).padStart(7), String(r.lost).padStart(4), String(r.maxInflight).padStart(7), r.note ?? ""].join(" | "));
		expect(rows.length).toBeGreaterThan(20);
	}, 120_000);

	const get = (s: number, e: string) => Object.values(all)[s]!.find((o) => o.exec === e)!;
	it("the sequential executors are always correct", () => { for (const rows of Object.values(all)) for (const e of ["js-seq", "ir-seq"]) expect(rows.find((o) => o.exec === e)!.stateOk, `${rows[0]!.scenario} ${e}`).toBe(true); });
	it("the hazards are real: unaware parallel JS loses updates (S2) and is refused (S3)", () => {
		expect(get(1, "js-naive").lost).toBeGreaterThan(0);
		expect(get(1, "js-naive").stateOk).toBe(false);
		expect(get(2, "js-naive").refused).toBeGreaterThan(0);
	});
	it("the optimised logical program is correct wherever the sequential one is, except where it has not been told a limit", () => {
		for (const [i, rows] of Object.values(all).entries()) {
			const par = rows.find((o) => o.exec === "ir-par")!;
			if (i === 2) expect(par.stateOk).toBe(false); // unaware of the limit of 4 (default 8 in flight): refused calls
			else expect(par.stateOk, par.scenario + " " + (par.note ?? "")).toBe(true);
		}
		expect(get(2, "ir-par-aware").stateOk).toBe(true);
	});
	it("with declared effects the engine keeps same-key writes in order but overlaps different keys (S2)", () => {
		expect(get(1, "ir-par").lost).toBe(0);
		expect(get(1, "ir-par").maxInflight).toBeGreaterThan(1);
		expect(get(1, "ir-par").wallMs).toBeLessThan(get(1, "ir-seq").wallMs * 0.6);
	});
	it("a failed step's dependents are not called: unaware JS calls them anyway (S5), the engine does not", () => {
		expect(get(4, "js-naive").extraCalls).toBeGreaterThan(0);
		expect(get(4, "ir-par").extraCalls).toBe(0);
		expect(get(4, "ir-par").maxInflight).toBeGreaterThan(3); // partial arguments: the keys are known before the values
	});
	it("independent fan-out is faster than the sequential program (S1)", () => { expect(get(0, "ir-par").wallMs).toBeLessThan(get(0, "ir-seq").wallMs * 0.4); });
});
