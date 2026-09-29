/**
 * DC-58 — the /model picker SCROLLS on a real terminal (the owner, 2026-09-21).
 *
 * With more profiles than one screen holds, the picker used to offer nine
 * rows and `/model <name>` for the rest: `PICK_MAX` was the list's REACH, not
 * its window. This gate proves the reachable set is the whole list, in bytes
 * on a real pty, and that the block says which rows are on screen.
 *
 * Twelve profiles, arranged so the LAST one is the only one with a distinct
 * model id: if the arrows had stopped at row nine, the durable profile would
 * still say `model-nine-ish` and the notice would name `p9`.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { ptyRun } from "./helpers/pty.js";

const plain = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** p1..p12; only the last carries a model id of its own. */
function twelve(): Record<string, unknown> {
	const models: Record<string, unknown> = {};
	for (let i = 1; i <= 12; i += 1) {
		models[`p${i}`] = { kind: "openai-compat", model: i === 12 ? "model-twelve" : "model-shared", apiKeyEnv: "SCROLL_KEY", baseUrl: "http://127.0.0.1:9" };
	}
	return { models };
}

describe("DC-58 — /model on a real pty: twelve profiles, one screen, arrows that reach the end", () => {
	it("↓ twelve times then enter switches to the TWELFTH profile, and the block names the rows on screen", () => {
		const { dirs, env } = isolatedEnv();
		writeFileSync(join(dirs.home, "config.json"), `${JSON.stringify(twelve())}\n`);
		const raw = ptyRun(["chat", "scroll-a", "--model", "p1"], { ...env, SCROLL_KEY: "fake" } as NodeJS.ProcessEnv, {
			feeds: [
				["/mode to switch", "/model\r"],
				["takes effect on the next turn", "exit\r"],
			],
			// twelve downs (the panel is up by ~2.5s — the R1.5 lesson), then
			// the confirm: the cursor is on row twelve, which is the twelfth
			// profile, not the ninth.
			delays: [
				[2.6, "\x1b[B"],
				[2.7, "\x1b[B"],
				[2.8, "\x1b[B"],
				[2.9, "\x1b[B"],
				[3.0, "\x1b[B"],
				[3.1, "\x1b[B"],
				[3.2, "\x1b[B"],
				[3.3, "\x1b[B"],
				[3.4, "\x1b[B"],
				[3.5, "\x1b[B"],
				[3.6, "\x1b[B"],
				[3.7, "\x1b[B"],
				[4.1, "\r"],
			],
		});
		const t = plain(raw);
		expect(t, "the block names the rows on screen and the gesture that moves them").toContain("— ↑↓ scrolls");
		expect(t, "and it names the whole list, not nine of twelve").toMatch(/↕ \d+-\d+ \/ 12/);
		expect(t, "the notice names the TWELFTH profile — the reach is the list").toContain("model → p12 (");
		// the durable half, DC-60 (declared): this session never received a
		// turn, so nothing of it is on disk — the selection lands with its
		// first durable event (packages/runtime/tests/dc60-no-empty-sessions)
		expect(existsSync(join(dirs.home, "sessions", "scroll-a.meta.json")), "a session with no event writes nothing").toBe(false);
	}, 240_000);
});
