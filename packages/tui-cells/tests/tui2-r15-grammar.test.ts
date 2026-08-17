/**
 * TUI2-R1.5 slice ⑤ — VD-6 + VD-11 + VD-15: one suffix grammar, human
 * language.
 *
 * The walkthrough counted three suffix forms on one screen and read the
 * line count twice on every read card
 * (`✓ read  f0.txt (2 lines, 0.0s) · 2 lines · ctrl+r expands`). It also
 * read `approved by mode:default` nine times — the kernel's own backfill
 * for "nobody actually decided this", presented as an attribution — and
 * a raw model-channel advisory, and a panel label written as a design
 * note (`— the full args — never truncated —`).
 *
 * The pinned grammar, applied uniformly:
 *   - collapsed WITH hidden content: `(<result>, <dur>) · N lines ·
 *     ctrl+r expands`, the count EXACTLY ONCE;
 *   - a cell with nothing hidden: no suffix;
 *   - policy auto-allows: NO attribution; a human verdict: ` · approved`
 *     or ` · denied`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cellComponent, type BodyCell, type FrameCtx } from "../src/components.js";

beforeEach(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
});
afterEach(() => {
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

const CTX: FrameCtx = { spinnerI: 0, now: 10_000, height: 24 };

function toolCell(over: Partial<Extract<BodyCell, { kind: "tool" }>> = {}): Extract<BodyCell, { kind: "tool" }> {
	return {
		kind: "tool",
		name: "read_file",
		input: JSON.stringify({ path: "src/parser.ts" }),
		inputFull: JSON.stringify({ path: "src/parser.ts" }, null, 2),
		childRoles: [],
		state: "done",
		isError: false,
		resultText: "alpha\nbeta",
		diff: null,
		added: 0,
		removed: 0,
		startedAt: 8_000,
		doneAt: 10_400,
		done: true,
		expanded: false,
		turn: 0,
		rolled: null,
		reason: null,
		verdict: null,
		...over,
	} as Extract<BodyCell, { kind: "tool" }>;
}

const render = (cell: BodyCell, W = 100): string[] => cellComponent(cell).render(W, CTX);

describe("TUI2-R1.5 ⑤ — the line count is stated exactly once (VD-6)", () => {
	it("a read card names its lines in the SUFFIX, not in the parens as well", () => {
		const row = render(toolCell())[0]!;
		expect(row.match(/\d+ lines?/g) ?? []).toHaveLength(1);
		expect(row).toBe("✓ read  src/parser.ts (2.4s) · 2 lines · ctrl+r expands");
	});

	it("a read whose result the TOOL truncated keeps its own of-N meta — that is a different fact", () => {
		const row = render(toolCell({ resultText: `${Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n")}\n… 50 more lines` }))[0]!;
		expect(row).toContain("(200 of 250 lines, 2.4s)");
	});

	it("the affordance is never lost to a long target — the shortest tier is reserved", () => {
		const long = `src/${"a".repeat(80)}.ts`;
		const row = render(toolCell({ inputFull: JSON.stringify({ path: long }) }))[0]!;
		expect(row.length).toBeLessThanOrEqual(100);
		expect(row).toContain("ctrl+r");
	});
});

describe("TUI2-R1.5 ⑤ — approval attribution is about humans (VD-11)", () => {
	it("a POLICY auto-allow says NOTHING — the ambient default is not an attribution", () => {
		const row = render(toolCell({ verdict: { decision: "approved", decidedBy: "mode:default" } }))[0]!;
		expect(row).not.toContain("approved by");
		expect(row).not.toContain("mode:default");
		expect(row).toBe("✓ read  src/parser.ts (2.4s) · 2 lines · ctrl+r expands");
	});

	it("a HUMAN approval says ` · approved` — the thing the human actually did", () => {
		const row = render(toolCell({ verdict: { decision: "approved" } }))[0]!;
		expect(row).toContain(" · approved");
		expect(row).not.toContain("approved by");
	});

	it("a HUMAN denial says ` · denied`; a policy denial keeps only its reason", () => {
		const human = render(toolCell({ isError: true, reason: "no touch", resultText: "[Permission denied] no touch", verdict: { decision: "denied" } }))[0]!;
		expect(human).toContain("(no touch · denied)");
		const policy = render(
			toolCell({ isError: true, reason: "no touch", resultText: "[Permission denied] no touch", verdict: { decision: "denied", decidedBy: "mode:plan" } }),
		)[0]!;
		expect(policy).toContain("(no touch)");
		expect(policy).not.toContain("mode:plan");
	});

	it("no verdict at all leaves the row bare — unchanged", () => {
		expect(render(toolCell())[0]).not.toContain("approved");
	});
});

describe("TUI2-R1.5 ⑤ — the model-channel advisory reads as an aside (VD-11)", () => {
	it("the non-idempotent advisory renders DIM in the card, and the durable text is untouched", () => {
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		const raw = "boom\n[non-idempotent tool failed — its side effects may have partially applied; verify before retrying]";
		const cell = toolCell({ name: "shell", isError: true, resultText: raw, inputFull: JSON.stringify({ command: "rm -rf x" }) });
		const rows = render(cell);
		const advisory = rows.find((r) => r.includes("non-idempotent"))!;
		expect(advisory).toBeDefined();
		// dim, and NOT red — the failure is the red thing, the advisory is an aside
		expect(advisory).toContain("\x1b[2m");
		expect(advisory).not.toContain("\x1b[31m");
		// the cell's own durable text is byte-identical
		expect(cell.resultText).toBe(raw);
	});
});
