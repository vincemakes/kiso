/**
 * ADR-0061 — the approval line names every hunk, in either vocabulary.
 *
 * It read `input.search`/`input.replace` only, so a batch (the only form
 * the model now sends) asked for approval of "replace:  with: " — nothing.
 */

import { describe, expect, it } from "vitest";
import { renderEvent } from "../src/lines.js";

const ask = (input: Record<string, unknown>) => renderEvent({ type: "permission_requested", name: "edit_file", input } as never).text;

describe("the approval line for edit_file", () => {
	it("shows each oldText/newText hunk, the same as the legacy names", () => {
		const now = ask({ path: "f.js", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] });
		const then = ask({ path: "f.js", edits: [{ search: "a", replace: "b" }, { search: "c", replace: "d" }] });
		expect(now).toBe(then);
		expect(now).toMatch(/replace: a\n\s+with:\s+b/);
		expect(now).toMatch(/replace: c\n\s+with:\s+d/);
	});

	it("keeps the legacy top-level pair", () => {
		expect(ask({ path: "f.js", search: "a", replace: "b" })).toMatch(/replace: a\n\s+with:\s+b/);
	});
});
