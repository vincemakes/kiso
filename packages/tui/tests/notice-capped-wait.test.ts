/**
 * 0.50.1 (ADR-0058 Amendment 16) — a command promoted at the foreground
 * ceiling is said as a TASK row. The CLI writes `✦ task <id> · …`; the
 * existing `✦ task` shape labels it, so the notice grammar needs no new
 * shape: label, then one sentence with `·` between its parts.
 */
import { describe, expect, it } from "vitest";
import { noticeMeta } from "../src/notice-meta.js";

describe("0.50.1 — the capped wait's row", () => {
	it("is a TASK row: the id, where it went, the limit, what was asked", () => {
		expect(noticeMeta("✦ task t3 · moved to the background at the 5m limit · asked 6m 40s")).toEqual({
			label: "TASK",
			sentence: "t3 · moved to the background at the 5m limit · asked 6m 40s",
		});
	});
});
