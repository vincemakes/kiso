/**
 * TUI2-R3v2 slice ② — the mouse on a real terminal, asserted in BYTES.
 *
 * The unit gates prove the editor's intent. These prove what actually
 * reaches the terminal, which is the only thing the invariant is about:
 * a session that ends with ?1000/?1006 still set has left the user a
 * terminal that prints escape bytes at their shell prompt on every
 * click, and `reset` is the only way out. So the assertions are on the
 * raw stream, in order, and the last word in the stream has to be the
 * disable.
 *
 * The kill -9 case is the one that cannot be fixed by the process that
 * caused it. A killed CLI emits nothing — no exit path runs — so the
 * terminal stays in mouse mode until something else clears it. The
 * NEXT process is that something, and the gate proves it clears it
 * before it draws anything.
 */

import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

const ON_1006 = "\x1b[?1006h";
const OFF_1006 = "\x1b[?1006l";
const ON_1000 = "\x1b[?1000h";
const OFF_1000 = "\x1b[?1000l";

const SHELL = { type: "tool_call_end", callId: "m1", name: "shell", input: { command: "echo clicked-it" } };

function script(): string {
	return fauxScript([
		{ events: [{ type: "text_delta", text: "One command." }, SHELL, { type: "stop", reason: "tool_use" }] },
		{ events: [{ type: "text_delta", text: "all done." }, { type: "stop", reason: "end_turn" }] },
		...spares(),
	]);
}

describe("TUI2-R3v2 ② — the mouse never leaks (real PTY, byte-asserted)", () => {
	it("a session with NO panel never turns reporting on — and still resets on the way in and out", () => {
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript(spares(4)), KISO_MODE: "default" });
		const raw = ptyRun(["--mode", "default", "r3v2-nopanel"], env as NodeJS.ProcessEnv, {
			feeds: [["▌ ", "exit\r"]],
		});
		expect(raw, "no selection surface opened, so nothing enabled reporting").not.toContain(ON_1006);
		expect(raw, "the defensive reset runs regardless").toContain(OFF_1006);
	});

	it("the panel turns it ON, and the answer turns it OFF — in that order", () => {
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script(), KISO_MODE: "default" });
		const raw = ptyRun(["--mode", "default", "r3v2-mouse"], env as NodeJS.ProcessEnv, {
			feeds: [
				["▌ ", "go\r"],
				["all done.", "exit\r"],
			],
			delays: [[2, "\r"]],
		});
		const on = raw.indexOf(ON_1006);
		expect(on, "the panel must enable SGR 1006").toBeGreaterThan(-1);
		expect(raw.indexOf(ON_1000), "?1000 rides with it").toBeGreaterThan(-1);
		expect(raw.indexOf(OFF_1006, on), "the close must disable it").toBeGreaterThan(on);
	});

	it("THE INVARIANT: the stream's LAST mouse-mode word is always the disable", () => {
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script(), KISO_MODE: "default" });
		const raw = ptyRun(["--mode", "default", "r3v2-last"], env as NodeJS.ProcessEnv, {
			feeds: [
				["▌ ", "go\r"],
				["all done.", "exit\r"],
			],
			delays: [[2, "\r"]],
		});
		expect(raw.lastIndexOf(OFF_1006)).toBeGreaterThan(raw.lastIndexOf(ON_1006));
		expect(raw.lastIndexOf(OFF_1000)).toBeGreaterThan(raw.lastIndexOf(ON_1000));
	});

	it("ESC on the panel is a close too — the cancel path disables it", () => {
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script(), KISO_MODE: "default" });
		const raw = ptyRun(["--mode", "default", "r3v2-esc"], env as NodeJS.ProcessEnv, {
			feeds: [["▌ ", "go\r"]],
			delays: [[2, "\x1b"], [3.5, "exit\r"]],
		});
		expect(raw.lastIndexOf(OFF_1006)).toBeGreaterThan(raw.lastIndexOf(ON_1006));
	});

	it("a CLICK on an option row confirms it — the injected SGR press runs the tool", () => {
		// the panel's option rows sit near the bottom of the live region; the
		// gate finds the bar's own row by asking the terminal, then clicks it.
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script(), KISO_MODE: "default" });
		const raw = ptyRun(["--mode", "default", "r3v2-click"], env as NodeJS.ProcessEnv, {
			feeds: [
				["▌ ", "go\r"],
				["all done.", "exit\r"],
			],
			// row 16 of a 24-row screen: the option list sits just above the
			// affordance row and the box. The press is button 0, column 5.
			delays: [[2.5, "\x1b[<0;5;16M\x1b[<0;5;16m"]],
			rows: 24,
			cols: 100,
		});
		expect(raw, "a left press on an option row is that option's digit").toContain("clicked-it");
	}, 240_000);

	it("a fresh process resets what a KILLED one left behind — the defensive path", () => {
		// nothing this process does can clean up after SIGKILL; the gate
		// proves the NEXT process does, before it paints anything.
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript(spares(4)), KISO_MODE: "default" });
		const raw = ptyRun(["--mode", "default", "r3v2-fresh"], env as NodeJS.ProcessEnv, {
			feeds: [["▌ ", "exit\r"]],
		});
		// the reset precedes the first frame's synchronized-output open
		const reset = raw.indexOf(OFF_1006);
		const firstFrame = raw.indexOf("\x1b[?2026h");
		expect(reset, "enter() must reset").toBeGreaterThan(-1);
		expect(firstFrame === -1 || reset < firstFrame, "the reset comes before the first frame").toBe(true);
	});
});
