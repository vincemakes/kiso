/**
 * R3i phase 5 — THE ANSWERED QUESTION HAS A BLOCK.
 *
 * Today a settled `ask_user` renders `  ask_user  (3 lines, 41.2s) ·
 * ctrl+r` — an empty target and the answers thrown away, even though
 * the tool_result already carries them as JSON (`{answers:[{q, choice
 * | choices | custom}]}` from `askAnswers`, `{declined:[…]}` from
 * `askDeclineAll`). The owner asked for the block by pointing at one:
 * after they answer, there is a display for that too.
 *
 * The shape, in kiso's own grammar (§7.4 — verb · target · outcome,
 * then the bounded block's `│` gutter):
 *
 *   asked 2 questions (answered, 41.2s)
 *   │ deploy target → staging
 *   │ retry policy → give up after 3 attempts (typed)
 *
 * The question is dim, the join is dim, and the ANSWER is at body
 * strength — strip every escape and every fact survives (law 1.2:
 * colour is emphasis, never information).
 *
 * It is WORDS, not work (law 1.7), so it never folds into a stretch
 * line: an answer is a durable fact the human gave, and the one thing
 * a summary must not do is speak for the human.
 */

import { describe, expect, it } from "vitest";
import { askedBlock } from "../src/components.js";
import { visibleWidth } from "../src/width.js";

const plain = (rows: string[]): string => rows.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const ANSWERED = JSON.stringify({
	answers: [
		{ q: "deploy target", choice: "staging" },
		{ q: "retry policy", custom: "give up after 3 attempts" },
		{ q: "notify", choices: ["slack", "email"] },
	],
});
const DECLINED = JSON.stringify({ declined: ["deploy target (staging, production)", "retry policy (give up, retry forever)"] });

describe("R3i — the answered block", () => {
	it("names how many were asked, that they were answered, and how long it took", () => {
		const rows = askedBlock(ANSWERED, 41.2, 90);
		expect(plain(rows).split("\n")[0]).toContain("asked 3 questions (answered, 41.2s)");
	});

	it("one question is singular", () => {
		const rows = askedBlock(JSON.stringify({ answers: [{ q: "target", choice: "staging" }] }), 2, 90);
		expect(plain(rows)).toContain("asked 1 question");
	});

	it("every question carries ITS answer, joined by the arrow", () => {
		const t = plain(askedBlock(ANSWERED, 41.2, 90));
		expect(t).toContain("deploy target → staging");
		expect(t).toContain("retry policy → give up after 3 attempts");
		expect(t).toContain("notify → slack, email"); // a multi-select keeps every pick
	});

	it("a TYPED answer says so — the provenance is a fact about the answer", () => {
		const t = plain(askedBlock(ANSWERED, 41.2, 90));
		expect(t).toContain("give up after 3 attempts (typed)");
		expect(t).not.toContain("staging (typed)");
	});

	it("a DECLINE records what went unanswered, and what the choices had been", () => {
		const t = plain(askedBlock(DECLINED, 8, 90));
		expect(t).toContain("asked 2 questions (declined, 8.0s)");
		expect(t).toContain("deploy target (staging, production)");
		expect(t).not.toContain("→");
	});

	it("every fact survives the escapes being stripped (law 1.2)", () => {
		const stripped = plain(askedBlock(ANSWERED, 41.2, 90));
		for (const fact of ["deploy target", "staging", "retry policy", "give up after 3 attempts", "(typed)"]) {
			expect(stripped).toContain(fact);
		}
	});

	it("ONE physical row each, never wider than W, at every width", () => {
		for (let W = 8; W <= 120; W += 1) {
			for (const payload of [ANSWERED, DECLINED]) {
				for (const row of askedBlock(payload, 41.2, W)) {
					expect(row, `W=${W}`).not.toMatch(/[\n\r]/);
					expect(visibleWidth(row), `W=${W}`).toBeLessThanOrEqual(W);
				}
			}
		}
	});

	it("a result that is not the ask's own JSON yields NOTHING — never a guess", () => {
		expect(askedBlock("some prose the tool happened to return", 1, 90)).toEqual([]);
		expect(askedBlock("", 1, 90)).toEqual([]);
		expect(askedBlock(JSON.stringify({ other: 1 }), 1, 90)).toEqual([]);
	});
});
