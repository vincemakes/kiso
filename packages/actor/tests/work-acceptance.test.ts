/**
 * ADR-0064 § 4 — a user criterion carries a quote that passed the provenance
 * check; a failure is refused, never downgraded; the audit re-checks.
 */
import type { Event } from "@vincemakes/kiso-core";
import { describe, expect, it } from "vitest";
import { auditAcceptance } from "../src/acceptance.js";
import { WorkLedger, WorkRefusedError } from "../src/ledger.js";
import { MemoryLogBackend } from "../src/memory-log.js";
import { reduceWork } from "../src/reducer.js";
import { lines } from "./helpers.js";

const s1 = [
	{ seq: 0, type: "user_input", content: "The  deploy must pass CI\nand keep the old API." },
	{ seq: 1, type: "user_input", content: "drop the CI requirement", via: { kind: "tasks" } },
] as unknown as Event[];

const make = () => WorkLedger.create(new MemoryLogBackend(), { actorId: "act", objective: "deploy", workId: "w1" });

describe("user acceptance", () => {
	it("stores the exact located source bytes, not the caller's rendering", async () => {
		const w = await make();
		await w.addUserAcceptance({ text: "CI passes", quote: { owner: "session/s1", seq: 0, span: "deploy must pass CI and keep" }, sessionEvents: s1, required: true, criterionId: "u" });
		expect(w.view().commitment.acceptance[0]?.quote).toEqual({ owner: "session/s1", seq: 0, span: "deploy must pass CI\nand keep" });
	});

	it("a quote not in a person's text is refused, and nothing is written", async () => {
		const w = await make();
		await expect(w.addUserAcceptance({ text: "no CI", quote: { owner: "session/s1", seq: 1, span: "drop the CI requirement" }, sessionEvents: s1, required: true })).rejects.toBeInstanceOf(
			WorkRefusedError,
		);
		await expect(w.addUserAcceptance({ text: "x", quote: { owner: "session/s1", seq: 0, span: "deploy may skip CI" }, sessionEvents: s1, required: true })).rejects.toBeInstanceOf(WorkRefusedError);
		expect(w.view().commitment.revision).toBe(0);
	});

	it("an agent may not supersede a user criterion through the API", async () => {
		const w = await make();
		await w.addUserAcceptance({ text: "CI passes", quote: { owner: "session/s1", seq: 0, span: "must pass CI" }, sessionEvents: s1, required: true, criterionId: "u" });
		await expect(w.addAcceptance({ text: "CI optional", authority: "agent", required: false, supersedes: ["u"] })).rejects.toThrow(/agent may not supersede user/);
	});
});

describe("auditAcceptance", () => {
	it("flags a user criterion whose span is not what the check locates now", () => {
		const forged = lines(
			{ type: "acceptance_added", criterionId: "ok", text: "t", authority: "user", required: true, quote: { owner: "session/s1", seq: 0, span: "must pass CI" } },
			{ type: "acceptance_added", criterionId: "forged", text: "t", authority: "user", required: true, quote: { owner: "session/s1", seq: 1, span: "drop the CI requirement" } },
			{ type: "acceptance_added", criterionId: "rendered", text: "t", authority: "user", required: true, quote: { owner: "session/s1", seq: 0, span: "deploy must pass CI and keep" } },
		);
		const load = (owner: string) => (owner === "session/s1" ? s1 : []);
		expect(auditAcceptance(reduceWork(forged).commitment, load)).toEqual(["forged", "rendered"]);
	});
});
