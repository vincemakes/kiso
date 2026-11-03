/**
 * The /resume band, picking a reply for /fork (owner 2026-11-03): its name says "fork after a reply", its enter
 * "⏎ forks", its empty line that no reply is finished yet, and the selected row opens on the card's detail (the line
 * the reply answered) instead of a session's facts.
 */

import { describe, expect, it } from "vitest";
import { sessionPickerRows, type SessionCardView } from "../src/session-picker.js";

const plain = (rows: readonly string[]): string => rows.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const card = (id: string, title: string, detail: string): SessionCardView => ({ id, title, detail, badge: "completed", turns: null, updatedAt: Date.now(), uncertain: 0, asks: 0, outcome: null });

describe("the band in fork mode", () => {
	it("names the fork, opens the selected reply on the line it answered, and says ⏎ forks", () => {
		const cards = [card("7", "sub adds.", "answered: which one is wrong?"), card("2", "It exports add and sub.", "answered: what does calc.js export?")];
		const out = plain(sessionPickerRows({ cards, matches: cards, selected: 0, kind: "fork" }, 100, Date.now()));
		expect(out).toContain("fork after a reply");
		expect(out).toContain("answered: which one is wrong?");
		expect(out).not.toContain("answered: what does calc.js export?");
		expect(out).toContain("⏎ forks");
		expect(out).not.toContain("resume");
	});

	it("says no reply is finished yet when there is none", () => {
		expect(plain(sessionPickerRows({ cards: [], matches: [], selected: 0, kind: "fork" }, 100, Date.now()))).toContain("no finished reply to fork after yet");
	});

	it("leaves /resume as it was", () => {
		const out = plain(sessionPickerRows({ cards: [], matches: [], selected: 0 }, 100, Date.now()));
		expect(out).toContain("resume");
		expect(out).toContain("nothing to resume yet");
	});
});
