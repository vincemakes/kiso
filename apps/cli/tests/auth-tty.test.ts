/**
 * OR-3 (2026-09-09) — the credential commands on a REAL TTY are plain
 * prompts; they never enter the editor.
 *
 * What the owner hit on 0.31.0: `kiso login chatgpt` in Terminal showed a
 * lone input box, then nothing, then the terminal's own OSC 11 reply
 * (`11;rgb:ffff/ffff/ffff`) typed at the bottom — and no sign-in. The cause:
 * main() built the shared line input BEFORE the command switch, and on a
 * TTY that means `editor.enter()` (raw mode, the process's single reader of
 * stdin) plus the ground probe (`CSI ?996n` + `OSC 11`). The login then
 * opened its OWN reader on the same stdin: the editor swallowed the
 * keystrokes, the terminal's probe reply was typed into the login's
 * readline, and the "open this URL" line vanished under the dock's repaint.
 *
 * The fix gives `login` / `logout` / `auth` an input over an EMPTY readable
 * — no editor, no probe, stdin untouched — so the hidden key prompt and the
 * OAuth paste prompt are the only readers. This file drives the built CLI
 * on a real pty and asserts the bytes: no probe, no mouse reset, the key
 * stored and never echoed, the listing printed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { ptyRun } from "./helpers/pty.js";

/** The ground probe main() sends when it enters the editor on a TTY. */
const PROBE = "\x1b[?996n\x1b]11;?\x07";
/** The mouse reset. The EDITOR writes it as its first byte out (editor.enter);
 *  the dock's exit teardown also writes it on any TTY, last, whether or not the
 *  dock ever entered (the "no broken terminal" contract byte, compositor.ts
 *  exit()). So the assertion is about ORDER, not presence: the prompt is the
 *  first byte out, and the only mouse reset comes after the work is done. */
const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l";
const KEY = "sk-tty-test-1234";

describe("OR-3 — kiso login / auth on a TTY never enter the editor", () => {
	it("login deepseek: no ground probe, no mouse reset; the key typed at the hidden prompt is stored 0600 and never echoed", () => {
		const { dirs, env } = isolatedEnv();
		const raw = ptyRun(["login", "deepseek"], env as NodeJS.ProcessEnv, { feeds: [["API key for deepseek", `${KEY}\r`]], timeout: 30 });
		expect(raw).not.toContain(PROBE);
		expect(raw.startsWith("API key for deepseek: ")).toBe(true); // the prompt is the first byte out — no editor before it
		expect(raw).toContain("signed in to deepseek");
		expect(raw.indexOf(MOUSE_OFF)).toBeGreaterThan(raw.indexOf("signed in to deepseek")); // only the exit teardown's reset, after the work
		expect(raw).not.toContain(KEY);
		const auth = JSON.parse(readFileSync(join(dirs.home, "auth.json"), "utf8")) as { credentials: Record<string, { key?: string }> };
		expect(auth.credentials.deepseek?.key).toBe(KEY);
	});

	it("auth on a TTY prints the listing and exits — no probe, no editor", () => {
		const { env } = isolatedEnv();
		const raw = ptyRun(["auth"], env as NodeJS.ProcessEnv, { timeout: 30 });
		expect(raw).not.toContain(PROBE);
		expect(raw.startsWith("credentials:")).toBe(true); // the listing is the first byte out
		expect(raw.indexOf(MOUSE_OFF)).toBeGreaterThan(raw.indexOf("env vars set")); // only the exit teardown's reset, after the listing
	});
});
