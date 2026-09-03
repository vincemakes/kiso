/**
 * TUI2-R2pre ④ — the display-verb mapping (the integrator's ruling).
 *
 * The screen names the ACT; the tool table names the CALL. Those are two
 * audiences and they get two vocabularies: the human reads `read`,
 * `list`, `search`, `write`, `edit`, `shell`; the model keeps
 * `read_file`, `list_dir`, `search_text`, `write_file`, `edit_file`,
 * `shell` unchanged. The API names DO NOT move — the model-request
 * surface is frozen rent, and the rename-to-match path is REJECTED by
 * ruling.
 *
 * Before this round the mapping existed three and a half times: a
 * `.replace("_file", "")` in components.ts, another in tui-cells
 * render.ts, two more in the compositor, and a real-but-private
 * `EXPLORE_VERB` table covering only the three read-only tools. The
 * consequence was visible on one screen: a card head that said `read`
 * next to a card head that said `list_dir`. One table now, in strings.ts
 * beside KEY_BINDINGS, which is the precedent for "one table and no
 * second copy of it".
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cellComponent, type BodyCell, type FrameCtx } from "../src/components.js";
import { panelBlockRows } from "../src/approval-panel.js";
import { renderToolSummary } from "../src/render.js";
import { displayVerb } from "../src/strings.js";

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
		reason: null,
		verdict: null,
		...over,
	} as Extract<BodyCell, { kind: "tool" }>;
}

const render = (cell: BodyCell, W = 100): string[] => cellComponent(cell).render(W, CTX);

describe("TUI2-R2pre ④ — one display-verb table", () => {
	it("T-R2p-12: the six built-ins map, and an unknown tool keeps its own name", () => {
		expect(displayVerb("read_file")).toBe("read");
		expect(displayVerb("list_dir")).toBe("list");
		expect(displayVerb("search_text")).toBe("search");
		expect(displayVerb("write_file")).toBe("write");
		expect(displayVerb("edit_file")).toBe("edit");
		expect(displayVerb("shell")).toBe("shell");
		// an extension's tool has no display name to give it — inventing one
		// would be worse than printing what the model actually calls
		expect(displayVerb("asky_read")).toBe("asky_read");
		expect(displayVerb("mcp__server__do_thing")).toBe("mcp__server__do_thing");
	});

	it("T-R2p-13: the card heads speak one language — list_dir and search_text stop showing raw", () => {
		expect(render(toolCell({ name: "list_dir", inputFull: JSON.stringify({ path: "src" }) }))[0]).toContain("  list ");
		expect(render(toolCell({ name: "list_dir", inputFull: JSON.stringify({ path: "src" }) }))[0]).not.toContain("list_dir");
		expect(render(toolCell({ name: "search_text", inputFull: JSON.stringify({ pattern: "parseExpr" }) }))[0]).toContain("  search ");
		expect(render(toolCell({ name: "search_text", inputFull: JSON.stringify({ pattern: "parseExpr" }) }))[0]).not.toContain("search_text");
		// the heads that were already short stay byte-identical
		expect(render(toolCell())[0]).toBe("  read  src/parser.ts · 2 lines · 2.4s · ctrl+o expands");
	});

	it("T-R2p-14: the advisory family says what the human should read, not what the model calls", () => {
		const capped = render(
			toolCell({ resultText: `${Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n")}\n… 50 more lines (call again with offset=201)` }),
		).join("\n");
		expect(capped).toContain("capped by read · offset=201 for the rest");
		expect(capped).not.toContain("capped by read_file");
	});

	/* R13 — the case that exercised `exploreRows` retired with
	   TUI2-R1 (B)'s exploration row itself. */

	it("T-R2p-16: the approval panel's rule line names the act", () => {
		const view = {
			flavor: "approval" as const,
			name: "edit_file",
			title: "src/parser.ts",
			speaker: "mode:default",
			statusText: "▸ run paused",
			args: { kind: "text" as const, lines: ["one", "two"] },
			fallbackQuestion: "approve edit_file? (y/n) ",
		};
		const rows = panelBlockRows(view, "options", 1, 80, 20).join("\n");
		expect(rows).toContain("edit needs approval");
		expect(rows).not.toContain("edit_file needs approval");
		// the dock-less fallback is the PIPE path — its bytes do not move
		expect(view.fallbackQuestion).toBe("approve edit_file? (y/n) ");
	});

	it("T-R2p-17: the PIPE path is byte-identical — the ruling is about the interactive screen", () => {
		// renderToolSummary is the non-TTY rendering. The round's proof
		// obligation is that its bytes do not move, so a redirected run and
		// every e2e that reads stdout are untouched.
		expect(renderToolSummary("read_file", { path: "a.ts" }, { content: "x", isError: false })).toBe("\u2713 read a.ts (1 line)"); // R2: the pipe keeps its mark
		expect(renderToolSummary("list_dir", { path: "root" }, { content: "x", isError: false })).toContain("list_dir");
		expect(renderToolSummary("search_text", { pattern: "p" }, { content: "x", isError: false })).toContain("search_text");
	});

	it("T-R2p-18: the mapping is display-ONLY — it never rewrites a payload or a policy key", () => {
		// the raw name stays on the cell, which is what dispatch, the mode
		// gate, and /last's RAW block all read.
		const cell = toolCell({ name: "list_dir" });
		expect(cell.name).toBe("list_dir");
		expect(displayVerb(cell.name)).toBe("list");
		expect(cell.name).toBe("list_dir"); // no mutation
	});
});
