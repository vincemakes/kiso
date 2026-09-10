/**
 * HF-2 (0.32.1) — a pasted multi-line first turn, then /resume.
 *
 * The session title is the first substantive prompt. A pasted heredoc as
 * that prompt kept its newlines in the title (runtime `sessionTitle`), and
 * the resume picker puts the title on one card row through the dock —
 * invariant ①b, the HF-1 crash by the road the owner walks next. On a real
 * PTY: the first turn arrives by bracketed paste with real newlines, the
 * run completes; a second process opens the picker with /resume and the
 * card shows the title as ONE row (the breaks as spaces), no invariant
 * fires; `kiso sessions` prints the title on one line. Under the suites'
 * KISO_INVARIANTS=throw.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { CLI, fauxScript, ptyRun, spares } from "./helpers/pty.js";

const PASTE = "\x1b[200~run this:\npython3 - <<'EOF'\nimport json\nEOF\x1b[201~";

describe("HF-2 — a multi-line first prompt on a real PTY", () => {
	it("the title is one row in the picker and one line in `kiso sessions`; nothing fires", () => {
		const { env, dirs } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([
				{ events: [{ type: "text_delta", text: "Noted the heredoc." }, { type: "stop", reason: "end_turn" }] },
				...spares(3),
			]),
			KISO_MODE: "bypass",
		});
		const workdir = mkdtempSync(join(tmpdir(), "kiso-hf2-"));
		// process 1: the pasted multi-line first turn, then exit
		const first = ptyRun(["--mode", "bypass", "hf2-title"], env as NodeJS.ProcessEnv, {
			cwd: workdir,
			feeds: [
				["/ commands · ↑ history", `${PASTE}\r`],
				["took ", "exit\r"], // the recap (keyed on the plain word — the ✦ carries SGR between it and the word): the run is over
			],
			timeout: 60,
		});
		expect(first, "the first turn itself must not fire").not.toContain("invariant ①b");

		// the listing: one line per session, the title on it
		const listing = spawnSync("node", [CLI, "sessions"], { cwd: workdir, env: env as NodeJS.ProcessEnv, encoding: "utf8" });
		const line = listing.stdout.split("\n").find((l) => l.includes("hf2-title")) ?? "";
		expect(line, "the listing row names the session").not.toBe("");
		expect(line, "the listing row carries the title on ONE line").toContain("run this: python3 - <<'EOF' import json EOF");

		// process 2: a fresh session opens the picker with /resume
		const second = ptyRun(["--mode", "bypass", "hf2-second"], env as NodeJS.ProcessEnv, {
			cwd: workdir,
			feeds: [
				["/ commands · ↑ history", "/resume\r"],
				["run this:", "\x1b"], // the picker is up with the title; esc closes it (alone: esc+letter in one write is alt)
			],
			delays: [[10, "exit\r"]], // the picker has closed by then; the prompt needle already fired once, so a clock ends the scenario
			timeout: 40,
		});
		const plain = second.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
		expect(plain, "the picker fired the invariant on the title").not.toContain("invariant ①b");
		expect(plain, "the picker shows the title as one row").toContain("run this: python3 - <<'EOF' import json EOF");
		expect(dirs.home).toBeTruthy();
	}, 180_000);
});
