/**
 * 0.47.1 — the colour tier from what the terminal IS, not only from what
 * it says (owner, 2026-10-07). Windows Terminal renders 24-bit and does not
 * set COLORTERM: kiso drew it in the 256 tier, where the person's cream
 * block became pink (index 224) and its gold edge olive (186).
 */
import { describe, expect, it } from "vitest";
import { terminalTier } from "../src/graphite.js";

describe("terminalTier: 24-bit where the terminal is known to render it", () => {
	it("COLORTERM still decides first, both ways it can be said", () => {
		expect(terminalTier({ COLORTERM: "truecolor" }, "darwin")).toBe("24bit");
		expect(terminalTier({ COLORTERM: "24bit" }, "linux")).toBe("24bit");
	});

	it("Windows Terminal (and WSL inside it) says WT_SESSION, not COLORTERM", () => {
		expect(terminalTier({ WT_SESSION: "5e3a…" }, "linux")).toBe("24bit");
		expect(terminalTier({ WT_SESSION: "5e3a…" }, "win32")).toBe("24bit");
	});

	it("a Windows console without WT_SESSION renders 24-bit too", () => {
		expect(terminalTier({}, "win32")).toBe("24bit");
	});

	it("the terminals known to render 24-bit, by what each one sets", () => {
		for (const env of [
			{ TERM_PROGRAM: "iTerm.app" },
			{ ITERM_SESSION_ID: "w0t0p0" },
			{ TERM_PROGRAM: "WezTerm" },
			{ WEZTERM_PANE: "0" },
			{ TERM_PROGRAM: "ghostty" },
			{ GHOSTTY_RESOURCES_DIR: "/x" },
			{ KITTY_WINDOW_ID: "1" },
			{ TERM_PROGRAM: "vscode" },
			{ TERM_PROGRAM: "WarpTerminal" },
			{ TERM: "alacritty" },
			{ TERMINAL_EMULATOR: "JetBrains-JediTerm" },
		]) {
			expect(terminalTier(env, "darwin"), JSON.stringify(env)).toBe("24bit");
		}
	});

	it("an unknown terminal, and Apple Terminal without COLORTERM, keep the 256 tier", () => {
		expect(terminalTier({ TERM: "xterm-256color" }, "linux")).toBe("256");
		expect(terminalTier({ TERM_PROGRAM: "Apple_Terminal" }, "darwin")).toBe("256");
		expect(terminalTier({}, "darwin")).toBe("256");
	});

	it("inside tmux or screen only COLORTERM counts: the outer terminal's variables leak in, its rendering does not", () => {
		expect(terminalTier({ TMUX: "/tmp/tmux-1/default,1,0", WT_SESSION: "x", TERM: "tmux-256color" }, "linux")).toBe("256");
		expect(terminalTier({ TERM: "screen-256color", ITERM_SESSION_ID: "w0" }, "darwin")).toBe("256");
		expect(terminalTier({ TMUX: "/tmp/tmux-1/default,1,0", COLORTERM: "truecolor" }, "linux")).toBe("24bit");
	});
});
