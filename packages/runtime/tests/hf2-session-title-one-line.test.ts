/**
 * HF-2 (0.32.1) — a session title is ONE line, whatever the first prompt was.
 *
 * `sessionTitle` took the first substantive prompt, trimmed it and cut it to
 * 60 characters — and a pasted heredoc kept its newlines. Three consumers
 * put that title on a single row (the resume picker's card row, `kiso
 * sessions`, the session card), and the picker renders through the dock:
 * invariant ①b, the same crash the running card's head row had (HF-1),
 * reached by the road the owner walks next — pasting a multi-line first
 * turn and opening /resume. The fix is at the source, because this function
 * "has two consumers and may only have one definition" (its own comment): a
 * title is a label, so a break or a tab becomes one space, runs collapse,
 * and the 60-character cut applies to the projected line.
 */
import { describe, expect, it } from "vitest";
import { sessionTitle, type StoreRecord } from "../src/store.js";

const rec = (content: string): StoreRecord => ({ seq: 0, event: { type: "user_input", content } } as unknown as StoreRecord);

describe("HF-2 — sessionTitle projects the first prompt to one line", () => {
	it("a pasted heredoc becomes one line, breaks as single spaces", () => {
		const t = sessionTitle([rec("run this:\npython3 - <<'EOF'\nimport json\nEOF")]);
		expect(t).not.toMatch(/[\n\r\t]/);
		expect(t).toBe("run this: python3 - <<'EOF' import json EOF");
	});
	it("CRLF, a bare CR, tabs and runs of blanks are one space each", () => {
		expect(sessionTitle([rec("a\r\nb\rc\td   e\n\n\nf")])).toBe("a b c d e f");
	});
	it("the 60-character cut applies to the projected line, never before it", () => {
		const t = sessionTitle([rec(`${"x".repeat(58)}\n${"y".repeat(10)}`)]);
		expect(t).toHaveLength(60);
		expect(t).not.toContain("\n");
	});
	it("an opener followed by the real prompt still picks the real one, projected", () => {
		expect(sessionTitle([rec("hi"), rec("fix\nthe build")])).toBe("fix the build");
	});
});
