/**
 * Graphite P1b — what the recovery panels quote, read from the execution
 * record the CLI already holds: a shell command verbatim, any other call's
 * target as its tool card names it, an interrupted ask's own questions.
 */

import { describe, expect, it } from "vitest";
import { askedQuestions, uncertainTarget } from "../src/trust-ui.js";

describe("P1b — the quoted lines", () => {
	it("a shell command is quoted whole, every line of it", () => {
		expect(uncertainTarget("shell", { command: "npm run migrate -- --env staging" })).toEqual(["npm run migrate -- --env staging"]);
		expect(uncertainTarget("shell", { command: "python3 - <<'EOF'\nprint(1)\nEOF" })).toEqual(["python3 - <<'EOF'", "print(1)", "EOF"]);
	});

	it("any other call is its tool card's target", () => {
		expect(uncertainTarget("edit_file", { path: "src/app.ts", old_string: "a", new_string: "b" })).toEqual(["src/app.ts"]);
		expect(uncertainTarget("read_file", { path: "kiso.json" })).toEqual(["kiso.json"]);
	});

	it("an interrupted ask's questions, as the model wrote them; none when the input has none", () => {
		expect(askedQuestions({ questions: [{ question: "which bundler?", options: [] }, { question: "which runners?", options: [] }] })).toEqual(["which bundler?", "which runners?"]);
		expect(askedQuestions({})).toEqual([]);
		expect(askedQuestions({ questions: "not a list" })).toEqual([]);
		expect(askedQuestions({ questions: [{ header: "no question field" }, null] })).toEqual([]);
	});
});
