/**
 * Graphite, the last sweep (owner, 2026-10-06) — on a real pty, the
 * replies that still printed in a pre-Graphite form:
 *
 *   - the opening names the session (no `session <id>` line above it),
 *     says the faux model and how to leave it (the `[faux mode …]` line was
 *     painted over at once), and counts the extensions;
 *   - a command's reply has no brackets, a two-line reply is one row;
 *   - `/skill` typed in full runs `/skill` (⏎ used to complete it to
 *     `/skills`);
 *   - `/last` and `/think` bring back a LAST CALL and a THINKING row;
 *   - `/clear` says the new session as a SESSION row.
 */

import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

const plain = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

describe("the last sweep on a real pty", () => {
	it("the opening, the replies, /skill, /last, /think and /clear in their Graphite forms", () => {
		const { env } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([
				{ events: [{ type: "thinking", text: "Weighing the workspace." }, { type: "tool_call_end", callId: "l1", name: "list_dir", input: {} }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "text_delta", text: "Looked around." }, { type: "stop", reason: "end_turn" }] },
				...spares(4),
			]),
		});
		const raw = ptyRun(["chat", "sweep-pty"], env as NodeJS.ProcessEnv, {
			// each needle is one span only the step before it can bring on
			// screen (the SKILLS row says "/skills lists them", so /skill's
			// reply is found by its usage)
			feeds: [
				["/mode to switch", "/think\r"],
				["no thinking yet", "/skill\r"],
				["usage: /skill <name>", "/mode bogus\r"],
				["no such mode: bogus", "go\r"],
				["Looked around.", "/last\r"],
				["LAST CALL", "/think\r"],
				["THINKING", "/clear\r"],
				["/resume sweep-pty returns", "exit\r"],
			],
		});
		const t = plain(raw);
		// the opening
		expect(t, "SESSION names the id").toMatch(/SESSION {5}sweep-pty · new · resumable after kill -9/);
		expect(t, "the line above the opening").not.toContain("session sweep-pty");
		expect(t, "the faux model, said where it stays").toMatch(/MODEL {7}faux · set an API key, or add a model to config\.json/);
		expect(t, "the painted-over line").not.toContain("[faux mode");
		expect(t, "EXTENSIONS counts").toMatch(/EXTENSIONS {2}\d+ · mcp, skills/);
		expect(t).not.toContain("extensions: built-in:");
		// the replies
		expect(t).toContain("no thinking yet");
		expect(t).not.toContain("[no thinking yet]");
		expect(t, "/skill ran").toContain("usage: /skill <name> [args…] — /skills lists them");
		expect(t, "/skill completed to /skills").not.toContain("unknown command");
		expect(t, "one row").toContain("no such mode: bogus · tiers: default accept-edits plan full-access");
		// /last and /think
		expect(t).toMatch(/LAST CALL {3}LIST \(root\) · \d+ lines?/);
		expect(t).toMatch(/ {2}input\s+\{\}\s+output/);
		expect(t, "the rules").not.toContain("--- list");
		expect(t).toMatch(/THINKING {4}the last block · 1 line\s+Weighing the workspace\./);
		// /clear
		expect(t).toMatch(/SESSION {5}\S+ · \/resume sweep-pty returns/);
		expect(t).not.toContain("switched — previous");
	}, 120_000);
});
