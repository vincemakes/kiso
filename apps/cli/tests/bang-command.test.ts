/**
 * §2.2 — the parse rule for `!cmd` / `!!cmd`, without a terminal.
 *
 * The dispatcher's own branch is proved on a real PTY
 * (`bang-command-pty.test.ts`); this pins the rule that decides whether a
 * submitted line is a shell gesture at all, because that decision is the
 * one that can quietly swallow someone's prose.
 */
import { describe, expect, it } from "vitest";
import { parseBang } from "../src/dispatch.js";

describe("§2.2 — what counts as the shell gesture", () => {
	it("`!` sends, `!!` does not, and the longer prefix wins", () => {
		expect(parseBang("!echo hi")).toEqual({ command: "echo hi", send: true });
		expect(parseBang("!!echo hi")).toEqual({ command: "echo hi", send: false });
	});

	it("the command is trimmed, and a bare marker carries no command", () => {
		expect(parseBang("!   npm test  ")).toEqual({ command: "npm test", send: true });
		expect(parseBang("!")).toEqual({ command: "", send: true });
		expect(parseBang("!!")).toEqual({ command: "", send: false });
	});

	it("a line that does not begin with ! is a turn", () => {
		expect(parseBang("hello")).toBeNull();
		expect(parseBang("what does ! mean")).toBeNull();
		// the escape is the dispatcher's, not the parser's: `\!` never
		// reaches here, and if it did it would still not be the gesture.
		expect(parseBang("\\!echo hi")).toBeNull();
	});

	it("a multi-line paste beginning with ! is prose", () => {
		// the same rule `/` already follows: a pasted block that happens to
		// start with the marker is content, and running it would be the
		// worst possible reading of a paste.
		expect(parseBang("!echo hi\nand then some prose")).toBeNull();
	});
});
