/**
 * Graphite R3d — `/name` on a real PTY: the person names the session, the
 * terminal title says the name, the sidecar keeps it, and a resumed
 * session opens under it. `/name` alone shows it; `/name -` clears it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";
import { cardFromListing } from "../src/session-cards.js";
import { windowTitleText } from "../src/window-title.js";

const sidecar = (home: string, id: string): Record<string, unknown> => {
	const path = join(home, "sessions", `${id}.meta.json`);
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
};
const titles = (raw: string): string[] => [...raw.matchAll(/\x1b\]0;([^\x07]*)\x07/g)].map((m) => m[1]!);

describe("R3d — /name", () => {
	it("names the session: the title says it, the sidecar keeps it, `/name` shows it, a resume opens under it", () => {
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript([{ events: [{ type: "text_delta", text: "done." }, { type: "stop", reason: "end_turn" }] }, ...spares(3)]) });
		const first = ptyRun(["chat", "named-a"], env as NodeJS.ProcessEnv, {
			feeds: [
				["/mode to switch", "fix the resize repaint\r"],
				["done.", "/name   retry   work \r"],
				['named "retry work"', "/name\r"],
				["name: retry work", "exit\r"],
			],
		});
		expect(first).toContain('named "retry work"'); // the spaces collapse
		expect(first).toContain("name: retry work");
		expect(titles(first).some((t) => /^retry work \u2014 /.test(t)), titles(first).join(" | ")).toBe(true);
		expect(sidecar(dirs.home, "named-a").name).toBe("retry work");
		// the resumed session opens under its name, not its first line
		const second = ptyRun(["chat", "named-a"], env as NodeJS.ProcessEnv, { feeds: [["/mode to switch", "exit\r"]] });
		expect(titles(second)[0]).toMatch(/^retry work — /);
	}, 120_000);

	it("`/name -` clears it: the title is the first line again", () => {
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript([{ events: [{ type: "text_delta", text: "done." }, { type: "stop", reason: "end_turn" }] }, ...spares(3)]) });
		const raw = ptyRun(["chat", "named-b"], env as NodeJS.ProcessEnv, {
			feeds: [
				["/mode to switch", "write the notes\r"],
				["done.", "/name notes\r"],
				['named "notes"', "/name -\r"],
				["name cleared", "exit\r"],
			],
		});
		expect(raw).toContain("name cleared");
		expect(titles(raw).at(-1)).toMatch(/^write the notes — /);
		expect(sidecar(dirs.home, "named-b")).not.toHaveProperty("name");
	}, 120_000);
});

describe("R3d — the name wins where a session is named", () => {
	it("the window title", () => {
		expect(windowTitleText([{ type: "user_input", content: "fix the resize repaint", seq: 0 } as never], "kiso", "ready", "retry work")).toBe("retry work — kiso");
		expect(windowTitleText([{ type: "user_input", content: "fix the resize repaint", seq: 0 } as never], "kiso", "ready", null)).toBe("fix the resize repaint — kiso");
	});

	it("the /resume card", () => {
		const summary = { title: "fix the resize repaint", turns: 1, updatedAt: 5, state: "completed", uncertain: 0, asks: 0, workspaceUnknown: false, source: "run" as const };
		const base = { id: "s", mtime: 1, summary, workspace: "/w", profileName: null };
		expect(cardFromListing({ ...base, name: "retry work" }).title).toBe("retry work");
		expect(cardFromListing(base).title).toBe("fix the resize repaint");
		expect(cardFromListing({ ...base, summary: null, name: "retry work" }).title).toBe("retry work");
	});
});
