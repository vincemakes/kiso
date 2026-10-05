/**
 * TUI2-R3v2 slice ① — the approval block's rows once the options are a
 * LIST rather than a line.
 *
 * The old block spent one row on "1 Yes · 2 Yes, don't ask again · 3 No"
 * and, at narrow widths, dropped the middle option to save the row. A
 * list cannot do that and does not need to: each option owns a row, the
 * cursor is a FULL-ROW reverse bar (the R2 session picker's bar, shared
 * rather than re-derived), and the row the human is about to take is the
 * widest thing on screen instead of the hardest to find.
 *
 * The bar's arithmetic is the reason this gate sweeps widths: a reverse
 * bar is only a bar if it reaches the right edge, and a row that reaches
 * PAST it crashes the compositor's invariant ① rather than truncating
 * quietly. Exactly-W is the assertion, at every width the product claims
 * to survive.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { panelBlockRows, panelOptions, panelAffordance, panelStatus, panelLeadPlain } from "../src/approval-panel.js";
import type { PanelView } from "../src/approval-panel.js";
import { visibleWidth } from "../src/components.js";

// the bar IS SGR 7, so the palette has to be on: a non-TTY vitest run
// degrades to COLOR_OFF and every assertion here would pass vacuously.
beforeAll(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});

const view: PanelView = {
	flavor: "approval",
	name: "shell",
	title: "shell rm -rf build",
	speaker: "mode:default",
	statusText: "❯ run paused",
	args: { kind: "text", lines: ["rm -rf build && npm run build"] },
	fallbackQuestion: "approve shell? (y/n) ",
};

const simple: PanelView = { ...view, flavor: "simple", name: "trust", title: "trust this project?" };

/** The option rows of a rendered block, in order — the rows that carry a
 *  digit lead, selected or not. */
function optionRows(rows: string[]): string[] {
	return rows.filter((r) => /(^|\s)[1-9] [A-Z]/.test(r.replace(/\x1b\[[0-9;]*m/g, "")));
}

describe("TUI2-R3v2 ① — the option list and its bar", () => {
	it("every option owns a ROW — four for approval, two for simple", () => {
		expect(optionRows(panelBlockRows(view, "options", 0, 80, 20))).toHaveLength(4);
		expect(optionRows(panelBlockRows(simple, "options", 0, 80, 20))).toHaveLength(2);
	});

	it("the cursor row is a full-row reverse bar of EXACTLY W cells", () => {
		for (const W of [40, 60, 80, 100, 120]) {
			const rows = panelBlockRows(view, "options", 0, W, 20);
			const bar = rows.find((r) => r.includes("\x1b[7m"));
			expect(bar, `a bar at W=${W}`).toBeDefined();
			expect(visibleWidth(bar!), `bar width at W=${W}`).toBe(W);
			expect(bar!.endsWith("\x1b[27m")).toBe(true);
		}
	});

	it("EXACTLY ONE row is barred, and it is the one the cursor names", () => {
		for (const cursor of [0, 1, 2, 3]) {
			const rows = panelBlockRows(view, "options", cursor, 80, 20);
			expect(rows.filter((r) => r.includes("\x1b[7m"))).toHaveLength(1);
			const bar = rows.find((r) => r.includes("\x1b[7m"))!;
			expect(bar).toContain(panelOptions(view)[cursor]!.label);
		}
	});

	it("no row ever exceeds W — invariant ① across the width sweep", () => {
		for (const W of [24, 32, 40, 60, 80, 120]) {
			for (const cursor of [0, 3]) {
				for (const row of panelBlockRows(view, "options", cursor, W, 20)) {
					expect(visibleWidth(row), `W=${W} cursor=${cursor}: ${JSON.stringify(row)}`).toBeLessThanOrEqual(W);
				}
			}
		}
	});

	it("the middle options SURVIVE a narrow winch — a list drops no choice", () => {
		// the old one-row form dropped "don't ask again" below W=47; a row
		// per option cuts its LABEL and keeps the choice reachable.
		const rows = panelBlockRows(view, "options", 0, 40, 20);
		expect(optionRows(rows)).toHaveLength(4);
	});

	it("the affordance is the v4 hint line, and it counts the real options", () => {
		// MOVED (Graphite P4 — DECLARED): an approval's esc says it denies; the
		// range is an en dash, as on every key row
		expect(panelAffordance(view, "options", 0)).toBe("↑↓ move · ⏎ or click confirms · 1–4 instant · esc denies");
		expect(panelAffordance(simple, "options", 0)).toBe("↑↓ move · ⏎ or click confirms · 1–2 instant · esc");
	});

	// RE-DERIVED (Graphite P4, owner 2026-10-04 — DECLARED): the rule line
	// retired into the band's name (`needs you · asked by <speaker>`) and the
	// call's head (`SHELL …`). What this gate protects stands: the PTY gates
	// match frames on a RAW byte run, so the run they use now — the band's
	// facts — must be one contiguous span on the ground those gates run on
	// (the unknown one: a pty answers no ground query).
	it("the band's facts are ONE contiguous byte run on the unknown ground — the PTY gates' needle", () => {
		// the regression this gate exists for: splicing the "(amended)"
		// marker in with its own dim span closed and reopened the run, which
		// is invisible on screen and broke the byte sequence the PTY driver
		// matches frames on. The approval was never answered and the panel
		// hung. An ordinary approval's bytes are not ours to churn.
		// R2: the block OPENS with a dashed rule, so the rule LINE — the
		// sentence naming the tool and who asked — is row 1.
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		try {
			const band = panelBlockRows(view, "options", 0, 120, 20)[0]!;
			expect(band, "the needle must survive as ONE contiguous byte run").toContain("needs you · asked by");
		} finally {
			delete (process.stdout as { isTTY?: boolean }).isTTY;
		}
	});

	it("…and the AMENDED line says so, in one contiguous run of its own", () => {
		const band = panelBlockRows({ ...view, amended: true }, "options", 0, 120, 20)[0]!;
		expect(band).toContain("needs you · amended · asked by");
	});

	// MOVED (Graphite P4 — DECLARED): no `amend›` lead (the composer's row,
	// with a dim hint while it is empty); the block itself says where the
	// words go, since the bar stays under the panel; the status line keeps
	// the words for a terminal with no bar
	it("the typed phase says where the words GO, in the block, with no lead", () => {
		expect(panelLeadPlain(view, "amend", 3)).toBe("");
		expect(panelBlockRows(view, "amend", 3, 120, 20).join("\n")).toContain("your note goes to the model — it will propose a new call");
		expect(panelStatus(view, "amend", 3)).toBe("❯ your note goes to the model — it will propose a new call");
		expect(panelAffordance(view, "amend", 3)).toBe("⏎ sends · esc back to the choices");
	});
});
