/**
 * ADR-0064 § 6 / ADR-0063 § 5.2 — the neutral provenance check: a candidate
 * is located in the human-authored surface of one seq and returned as the
 * exact source bytes.
 */
import type { Event } from "@vincemakes/kiso-core";
import { describe, expect, it } from "vitest";
import { locateQuote } from "../src/provenance.js";
import { log, replaced, vetoed } from "./fixtures/history-logs.js";

const at = (events: Event[], seq: number, span: string) => locateQuote(events, { owner: "session/s1", seq, span })?.span ?? null;

const person = log([
	{ seq: 0, type: "user_input", content: "Never use  Redis\tfor   session state. Run `npm test -- --run` in packages/core!" },
	{ seq: 1, type: "user_input", content: "Ｕｓｅ ＰＯＳＴＧＲＥＳ　ｏｎｌｙ" },
	{ seq: 2, type: "user_input", content: "task done", via: { kind: "tasks" } },
	{ seq: 3, type: "user_input", content: "from a peer", via: { kind: "peer", from: "w2" } },
	{ seq: 4, type: "text_delta", text: "Never use Redis" },
]);

describe("locateQuote", () => {
	it("whitespace runs compare as one space; the stored span is the source's own bytes", () => {
		expect(at(person, 0, "use Redis for session state")).toBe("use  Redis\tfor   session state");
	});

	it("full-width forms compare as half-width; the stored span keeps the full-width bytes", () => {
		expect(at(person, 1, "Use POSTGRES only")).toBe("Ｕｓｅ ＰＯＳＴＧＲＥＳ　ｏｎｌｙ");
	});

	it("no punctuation folding: code, flags, paths and ! must match as written", () => {
		expect(at(person, 0, "`npm test -- --run` in packages/core!")).toBe("`npm test -- --run` in packages/core!");
		expect(at(person, 0, "npm test --run")).toBeNull();
		expect(at(person, 0, "packages/core.")).toBeNull();
	});

	it("only a person's own text: task and peer inputs, model output and an absent seq fail", () => {
		expect(at(person, 2, "task done")).toBeNull();
		expect(at(person, 3, "from a peer")).toBeNull();
		expect(at(person, 4, "Never use Redis")).toBeNull();
		expect(at(person, 9, "x")).toBeNull();
	});

	it("a hook-rewritten input quotes what the person typed, never the rewrite; a vetoed input quotes nothing", () => {
		expect(at(replaced, 0, "typed by the person")).toBe("typed by the person");
		expect(at(replaced, 0, "rewritten by the hook")).toBeNull();
		expect(at(vetoed, 0, "never sent")).toBeNull();
	});

	it("an empty or whitespace-only candidate is not a quote", () => {
		expect(at(person, 0, "   ")).toBeNull();
	});

	it("keeps the owner and seq it was given", () => {
		expect(locateQuote(person, { owner: "session/s9", seq: 0, span: "Redis" })).toEqual({ owner: "session/s9", seq: 0, span: "Redis" });
	});
});
