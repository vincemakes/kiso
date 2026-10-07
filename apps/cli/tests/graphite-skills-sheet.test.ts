/**
 * Graphite, the sheets round (owner, 2026-10-06) — `/skills` on a dock is a
 * sheet over the input, `/status`'s shape. The band says how many, how many
 * cannot load, and where they live when that is one place (cut from the
 * LEFT when the band cannot hold it, P4's rule for a path in a band); one
 * row per skill, `/name` in a measured column and its description dim; a
 * skill that cannot load says why in the failure colour; how to run one is
 * the closing row. On a pipe `/skills` prints `skillsRows`, unchanged.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SkillsCatalog } from "@vincemakes/kiso-skills-ext";
import { palette, setGround, visibleWidth } from "@vincemakes/kiso-tui";
import { skillsRows, skillsSheetRows } from "../src/skill-invoke.js";

const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
beforeAll(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => setGround("unknown"));

const entry = (name: string, description: string, userInvocable = true) => ({ name, description, dir: name, path: `/s/${name}/SKILL.md`, userInvocable });
const CATALOG = {
	entries: [entry("bench-report", "summarise a bench run's rows into the report table"), entry("release-notes", "draft release notes from the merged PRs since the last tag"), entry("inner", "only for the model", false)],
	broken: [{ dir: "half-done", reason: "no description" }],
} as unknown as SkillsCatalog;
const HOME = (): string => "~/.kiso/skills";

describe("the /skills sheet", () => {
	it("the band's facts; a row per skill in a measured column; the one that cannot load; the closing row", () => {
		setGround("light");
		const rows = skillsSheetRows(CATALOG, HOME, "~/.kiso/skills", 80).map(plain);
		expect(rows[0]).toMatch(/^─── skills · 3 · 1 cannot load · ~\/\.kiso\/skills ─+$/);
		expect(rows.slice(1)).toEqual([
			"  /bench-report   summarise a bench run's rows into the report table",
			"  /release-notes  draft release notes from the merged PRs since the last tag",
			"  /inner          only for the model (model only)",
			"  half-done       cannot load: no description",
			"  /<name> runs one · a built-in wins its name · esc closes",
		]);
	});

	it("the name in ink, the description dim, the reason a skill cannot load in the failure colour", () => {
		setGround("light");
		const p = palette();
		expect([p.dim, p.fail].includes(""), "the palette is on").toBe(false);
		const rows = skillsSheetRows(CATALOG, HOME, "~/.kiso/skills", 80);
		expect(rows[1]).toMatch(new RegExp(`^  /bench-report +${p.dim.replace(/\[/g, "\\[")}summarise`));
		expect(rows[4]).toContain(`${p.fail}cannot load: no description`);
	});

	it("more than one place: each row ends with where it lives, and the band names none", () => {
		setGround("light");
		const where = (dir: string): string => (dir === "inner" ? "./.kiso/skills" : "~/.kiso/skills");
		const rows = skillsSheetRows(CATALOG, where, "~/.kiso/skills", 120).map(plain);
		expect(rows[0]).toMatch(/^─── skills · 3 · 1 cannot load ─+$/);
		expect(rows[3]).toBe("  /inner          only for the model (model only) · ./.kiso/skills");
		expect(rows[1]).toMatch(/ · ~\/\.kiso\/skills$/);
	});

	it("a place too long for the band is cut from the LEFT: its own name and the rule's end stay", () => {
		setGround("light");
		const deep = (): string => "/home/dev/work/a-rather-long-monorepo-name/packages/tools/.kiso/kiso-sheets-k7a9jdw1/skills";
		const band = plain(skillsSheetRows(CATALOG, deep, "~/.kiso/skills", 80)[0]!);
		expect(band).toMatch(/^─── skills · 3 · 1 cannot load · …\S*kiso-sheets-k7a9jdw1\/skills ─+$/);
		expect(visibleWidth(band)).toBe(80);
	});

	it("none installed: the band says so, and the row says where one goes", () => {
		setGround("light");
		const rows = skillsSheetRows({ entries: [], broken: [] } as unknown as SkillsCatalog, HOME, "~/.kiso/skills", 80).map(plain);
		expect(rows[0]).toMatch(/^─── skills · none ─+$/);
		expect(rows[1]).toBe("  add one as ~/.kiso/skills/<name>/SKILL.md");
	});

	it("every row fits, W 20..160, on three grounds; no bare ESC; the pipe form is untouched", () => {
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (let W = 20; W <= 160; W += 1) {
				for (const r of skillsSheetRows(CATALOG, HOME, "~/.kiso/skills", W)) {
					expect(visibleWidth(r), `${g} W=${W}`).toBeLessThanOrEqual(W);
					expect(r.replace(/\x1b\[[0-9;]*m/g, ""), `${g} W=${W}`).not.toContain("\x1b");
				}
			}
		}
		expect(skillsRows(CATALOG, HOME, "~/.kiso/skills")).toEqual([
			"~/.kiso/skills",
			"  /bench-report — summarise a bench run's rows into the report table",
			"  /release-notes — draft release notes from the merged PRs since the last tag",
			"  /inner — only for the model (model only)",
			"  half-done — cannot load: no description",
			"/<name> [args] or /skill <name> [args] runs one · a built-in command wins a shared name",
		]);
	});
});
