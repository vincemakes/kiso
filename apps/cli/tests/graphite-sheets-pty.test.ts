/**
 * Graphite, the sheets round (owner, 2026-10-06) — the read-only sheets on a
 * real pty. The unit files pin each sheet's rows; this one pins the CLI's
 * wiring through the real binary: `/help` opens the command list, `/context`
 * and `/skills` open as sheets over the input and print nothing into the
 * conversation, what is typed while a sheet is up is typed (a command runs,
 * `exit` exits), and a sheet shorter than the `/` list that came before it
 * sits ON the composer — the rows the window cannot take back go above it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares, termAt } from "./helpers/pty.js";

const plain = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
function skill(root: string, name: string, description: string): void {
	mkdirSync(join(root, name), { recursive: true });
	writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nDo it.\n`, "utf8");
}
// a reply long enough to fill the screen, so the `/` list pushes rows into
// the scrollback and the window's top cannot come back down (R13)
const LONG = Array.from({ length: 22 }, (_, i) => `line ${i + 1} of the answer`).join("\n\n");

describe("the sheets round on a real pty", () => {
	it("/help opens the command list; /context and /skills are sheets; typing goes through; a short sheet sits on the composer", () => {
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript([{ events: [{ type: "text_delta", text: LONG }, { type: "stop", reason: "end_turn" }] }, ...spares(3)]) });
		skill(dirs.skills, "hello", "say hello properly");
		skill(dirs.skills, "review", "review the staged diff");
		const raw = ptyRun(["chat", "sheets"], env as NodeJS.ProcessEnv, {
			// needles only the surface they wait for can bring on screen (the
			// driver fires each the first time it appears anywhere, and the boot
			// frame's old key ladder says `/ commands`): the list's key row, the
			// /context meter's note, the /skills closing row
			feeds: [
				["/mode to switch", "go\r"],
				["line 22 of the answer", "/help\r"],
				["completes", "context\r"],
				["compaction past", "/skills\r"],
				["a built-in wins its name", "exit\r"],
			],
		});
		const t = plain(raw);
		expect(t, "/help opened the command list").toContain("commands · ");
		expect(t, "the /context sheet named its total").toMatch(/context · [\d.]+k? of [\d.]+k? · \d+%/);
		expect(t, "the /skills sheet").toMatch(/skills · 2 · /);
		expect(t).toMatch(/\/hello +say hello properly/);
		// nothing was printed into the conversation: the printed forms never
		// appear on a dock
		expect(t, "the printed /context").not.toContain("context — ");
		expect(t, "the printed /skills").not.toContain("/hello — ");
		expect(t, "the printed /help").not.toContain("print this list of commands");
		// what was typed with a sheet up was typed: `/skills` ran from the
		// /context sheet and `exit` left from the /skills sheet (the run
		// ending is the driver's own check)
		// the /skills sheet (four rows) is shorter than the `/` list (seven)
		// that came before it: it sits on the composer, the gap above it
		const screen = termAt(raw, "a built-in wins its name").visible();
		const rail = screen.findIndex((l, i) => i > 0 && /^─{20,}$/.test(l.trimEnd()) && /^\s*$/.test(screen[i + 1] ?? "x"));
		expect(rail, screen.join("\n")).toBeGreaterThan(0);
		expect(screen[rail - 1], `the row above the composer is the sheet's last\n${screen.join("\n")}`).toContain("esc closes");
	}, 120_000);

	it("the keys sheet: two columns at the content edge, the closing row, and what is typed is typed", () => {
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript(spares(3)) });
		const raw = ptyRun(["chat", "keys"], env as NodeJS.ProcessEnv, {
			feeds: [
				["/mode to switch", "?"],
				["─── keys", "exit\r"],
			],
		});
		const t = plain(raw);
		expect(t).toMatch(/ {2}enter +send +esc +stop the run/);
		expect(t).toContain("esc closes · typing goes to the input");
		expect(t, "the panels row retired").not.toContain("panels: ");
	}, 120_000);
});
