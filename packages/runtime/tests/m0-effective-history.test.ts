/**
 * ADR-0063 M0 — effective history (spec rev 2.2 § 3–§ 4). The parity test
 * is the one that enforces "no second interpreter": the current view of the
 * evidence must say what `projectMessages` renders. The other tests pin the
 * covered view, the statuses, the pairing rule and the two authority
 * functions.
 */

import { describe, expect, it } from "vitest";
import { projectMessages, resolveHistory } from "@vincemakes/kiso-core";
import {
	effectiveHistory,
	humanAuthority,
	humanAuthoredSurface,
	parityMismatches,
} from "../src/effective-history.js";
import { abandoned, all, authority, coveredPair, coveredPairLegacy, duplicateCallId, legacyTwin, plain, replaced, vetoed, voidedCovered } from "./fixtures/history-logs.js";

describe("M0 effective history", () => {
	it.each(Object.entries(all))("projection parity: %s", (_name, events) => {
		expect(parityMismatches(events)).toEqual([]);
	});

	it("coverage: covered evidence stays, effective, with coveredBy the live checkpoint's seq", () => {
		const ev = effectiveHistory(coveredPair);
		const at = (seq: number) => ev.find((e) => e.seq === seq)!;
		for (const seq of [0, 2, 4, 5]) expect(at(seq).provenance.coveredBy).toBe(11);
		expect(at(4)).toMatchObject({ kind: "tool", content: "tests passed", structuralStatus: "effective" });
		expect(at(7).provenance.coveredBy).toBeUndefined();
	});

	it("4b: the covered call and result pair, legacy twin included", () => {
		for (const events of [coveredPair, coveredPairLegacy]) {
			const result = effectiveHistory(events).find((e) => e.kind === "tool")!;
			expect(result.structuralStatus).toBe("effective");
			expect(result.provenance.coveredBy).toBe(11);
		}
	});

	it("voided wins over covered: an abandoned draft is never effective evidence", () => {
		const draft = effectiveHistory(voidedCovered).find((e) => e.content === "draft")!;
		expect(draft.structuralStatus).toBe("abandoned");
		expect(draft.provenance.coveredBy).toBeUndefined();
	});

	it("statuses: replaced (audit), vetoed, abandoned, orphaned", () => {
		expect(effectiveHistory(replaced).filter((e) => e.seq === 0).map((e) => [e.structuralStatus, e.content])).toEqual([["effective", "rewritten by the hook"]]);
		expect(effectiveHistory(replaced, { audit: true }).filter((e) => e.seq === 0).map((e) => e.structuralStatus)).toEqual(["replaced", "effective"]);
		expect(effectiveHistory(vetoed).find((e) => e.seq === 0)?.structuralStatus).toBe("vetoed");
		expect(effectiveHistory(abandoned).find((e) => e.content === "draft")?.structuralStatus).toBe("abandoned");
		const results = effectiveHistory(duplicateCallId).filter((e) => e.kind === "tool");
		expect(results.map((e) => [e.content, e.structuralStatus])).toEqual([["A", "effective"], ["B", "orphaned"]]);
	});

	it("4a: legacy pairing matches the projection (parity, not a fixed expectation)", () => {
		const evidenced = effectiveHistory(legacyTwin).filter((e) => e.kind === "tool" && e.structuralStatus === "effective").map((e) => e.content);
		const projected = projectMessages(legacyTwin).flatMap((m) => (m.role === "tool" ? [m.content] : []));
		expect(evidenced).toEqual(projected);
	});

	it("humanAuthority, one case per row", () => {
		expect(authority.map(humanAuthority)).toEqual(["user", "user", "runtime", "peer", "none", "user", "runtime"]);
		expect(humanAuthority(plain[1]!)).toBe("none");
	});

	it("humanAuthoredSurface: the person's own text, never a rewrite or an expanded body", () => {
		const r = resolveHistory(authority);
		expect(authority.map((e) => humanAuthoredSurface(e, r))).toEqual(["plain", "/deploy staging", null, null, null, "not on main", null]);
		const rr = resolveHistory(replaced);
		expect(humanAuthoredSurface(replaced[0]!, rr)).toBe("typed by the person");
		const rv = resolveHistory(vetoed);
		expect(humanAuthoredSurface(vetoed[0]!, rv)).toBeNull();
	});

	it("evidence authority follows humanAuthority (none becomes unknown)", () => {
		expect(effectiveHistory(authority).map((e) => e.authority)).toEqual(["user", "user", "runtime", "peer", "unknown", "user", "runtime"]);
	});
});
