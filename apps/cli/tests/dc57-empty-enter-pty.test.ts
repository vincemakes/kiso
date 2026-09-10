/**
 * DC-57 (0.32.1) — Enter on an EMPTY composer does nothing.
 *
 * Measured on the installed 0.32.0: a bare Enter at the idle prompt exited
 * the process (exit 0). `dispatch` treated a submitted empty line as `exit`
 * — a rule from the readline era that the docked editor inherited. The
 * owner's ruling (2026-09-10): a stray Enter must not end a session; on
 * the dock it is a no-op, and `exit` (or ctrl+c) remains the way out. The
 * pipe path keeps its byte-pinned end.
 *
 * On a real PTY: Enter on the empty composer, twice; the prompt is still
 * there and a turn still runs after it; `exit` then exits. Before: the
 * process was gone after the first Enter and "go" went nowhere.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

describe("DC-57 — a bare Enter on the empty composer", () => {
	it("does nothing: the prompt stays, a turn still runs, exit still exits", () => {
		const { env, dirs } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([
				{ events: [{ type: "text_delta", text: "Still here." }, { type: "stop", reason: "end_turn" }] },
				...spares(2),
			]),
			KISO_MODE: "bypass",
		});
		const workdir = mkdtempSync(join(tmpdir(), "kiso-dc57-"));
		const raw = ptyRun(["--mode", "bypass", "dc57"], env as NodeJS.ProcessEnv, {
			cwd: workdir,
			feeds: [["/ commands · ↑ history", "\r\r"]],
			delays: [
				[3, "go\r"], // after the two bare Enters: the session must still be here to take it
				[7, "exit\r"],
			],
			timeout: 30,
		});
		const plain = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
		expect(plain, "the turn after the bare Enters never ran — the session had exited").toContain("Still here.");
		const log = readFileSync(join(dirs.home, "sessions", "dc57.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { event: { type: string; content?: string } });
		const inputs = log.filter((e) => e.event.type === "user_input").map((e) => e.event.content);
		expect(inputs, "the bare Enters must not become turns either").toEqual(["go"]);
	}, 120_000);
});
