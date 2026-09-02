/**
 * TUI2-R3v2 slice ④ — the risk hint: FOUR patterns, and nothing else.
 *
 * The owner's ruling narrowed this deliberately. A warning on every
 * command teaches the eye to skip warnings, and the only commands that
 * earn a line here are the ones where "undo" does not exist: the bytes
 * are gone, the uncommitted work is gone, the commits are gone. Every
 * other command — including plenty of dangerous ones — renders NO hint,
 * because a hint that appears everywhere is decoration.
 *
 * Local string rules, zero requests, and it never blocks: the hint is a
 * sentence next to the command, not a gate in front of it.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { deletionRiskHint, panelBlockRows } from "../src/approval-panel.js";
import type { PanelView } from "../src/approval-panel.js";
import { visibleWidth } from "../src/components.js";

describe("TUI2-R3v2 ④ — the four irreversible-deletion patterns", () => {
	it("rm -rf names its TARGETS — the whole point is knowing what goes", () => {
		expect(deletionRiskHint("rm -rf node_modules dist")).toBe("deletes files permanently (node_modules, dist)");
		expect(deletionRiskHint("rm -rf build && npm run build")).toBe("deletes files permanently (build)");
		expect(deletionRiskHint("rm -fr ./tmp")).toBe("deletes files permanently (./tmp)");
		expect(deletionRiskHint("rm -r -f a b")).toBe("deletes files permanently (a, b)");
	});

	it("rm -rf with no nameable target still warns — the shape is the risk", () => {
		expect(deletionRiskHint("rm -rf $TARGET")).toBe("deletes files permanently ($TARGET)");
		expect(deletionRiskHint("rm -rf")).toBe("deletes files permanently");
	});

	it("git checkout -- discards uncommitted work", () => {
		expect(deletionRiskHint("git checkout -- .")).toBe("discards your uncommitted changes — unrecoverable");
		expect(deletionRiskHint("git checkout -- src/parser.ts")).toBe("discards your uncommitted changes — unrecoverable");
	});

	it("git reset --hard throws away commits and working changes", () => {
		expect(deletionRiskHint("git reset --hard HEAD~3")).toBe("throws away commits and working changes");
		expect(deletionRiskHint("git reset --hard")).toBe("throws away commits and working changes");
	});

	it("git clean -f deletes untracked files", () => {
		expect(deletionRiskHint("git clean -fd")).toBe("deletes untracked files permanently");
		expect(deletionRiskHint("git clean -f")).toBe("deletes untracked files permanently");
		expect(deletionRiskHint("git clean -xdf")).toBe("deletes untracked files permanently");
	});

	it("EVERY other command renders no hint — including the near misses", () => {
		for (const cmd of [
			"npm run build",
			"rm file.txt", // no -rf: a single file, and the shell asks nothing of us
			"rm -r build", // no -f
			"git checkout main", // a branch switch, not a discard
			"git checkout -b feature", // a new branch
			"git reset HEAD~1", // a MIXED reset keeps the working tree
			"git reset --soft HEAD~1",
			"git clean -n", // a dry run
			"git status",
			"echo rm -rf nothing-happens", // the words are an argument, not the command
			"dd if=/dev/zero of=/dev/sda", // dangerous, and NOT in the table: the
			// round rejects guessing. Four patterns, matched exactly.
			"",
		]) {
			expect(deletionRiskHint(cmd), JSON.stringify(cmd)).toBeNull();
		}
	});

	it("a compound command is scanned per segment — the risk can be the second half", () => {
		expect(deletionRiskHint("npm run clean && git clean -fd")).toBe("deletes untracked files permanently");
		expect(deletionRiskHint("cd /tmp; rm -rf junk")).toBe("deletes files permanently (junk)");
	});

	it("the FIRST matching segment wins — one line, never a stack of them", () => {
		expect(deletionRiskHint("rm -rf a && git clean -fd")).toBe("deletes files permanently (a)");
	});
});

describe("TUI2-R3v2 ④ — the hint in the block", () => {
	beforeAll(() => {
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	});

	const view = (riskHint?: string): PanelView => ({
		flavor: "approval",
		name: "shell",
		title: "shell rm -rf build",
		speaker: "mode:default",
		statusText: "▸ run paused",
		args: { kind: "text", lines: ["rm -rf build && npm run build"] },
		fallbackQuestion: "approve shell? (y/n) ",
		...(riskHint === undefined ? {} : { riskHint }),
	});

	it("renders directly under the args, in the palette's EXISTING warn yellow", () => {
		const rows = panelBlockRows(view("deletes files permanently (build)"), "options", 0, 80, 20);
		const at = rows.findIndex((r) => r.includes("deletes files permanently"));
		expect(at, "the hint must be in the block").toBeGreaterThan(-1);
		expect(rows[at - 1], "it sits under the args it is about").toContain("rm -rf build");
		expect(rows[at], "the warn entry — SGR 33, no new colour").toContain("\x1b[33m");
	});

	it("a view WITHOUT a hint renders no extra row — the block is unchanged", () => {
		const without = panelBlockRows(view(), "options", 0, 80, 20);
		const with_ = panelBlockRows(view("deletes files permanently (build)"), "options", 0, 80, 20);
		expect(with_.length).toBe(without.length + 1);
		// DC-42 re-derivation: this used to look for the retired warning
		// mark, which after its retirement is absent from EVERY panel and
		// so discriminates nothing — it would stay green even if the hint
		// row vanished from the WITH case too. The hint's own sentence is
		// what distinguishes the two blocks now, so that is what is asked.
		expect(without.join("")).not.toContain("deletes files permanently");
		expect(with_.join("")).toContain("deletes files permanently");
	});

	it("the hint row obeys invariant ① at every width, and its ROW is budgeted", () => {
		for (const W of [24, 40, 80, 120]) {
			// R2: the block spends one more row on its own frame (it opens with
		// a rule as well as closing with one), so the smallest budget that
		// can still hold the hint plus the list is one larger.
		for (const maxRows of [9, 12, 20]) {
				const rows = panelBlockRows(view("deletes files permanently (node_modules, dist, coverage)"), "options", 0, W, maxRows);
				expect(rows.length, `W=${W} maxRows=${maxRows}`).toBeLessThanOrEqual(maxRows);
				for (const row of rows) expect(visibleWidth(row), `W=${W}`).toBeLessThanOrEqual(W);
			}
		}
	});
});
