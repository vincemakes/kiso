/**
 * PH-1a (finding PH-F5, the isolation half) — the suite's environment
 * baseline. A host shell exporting NO_COLOR (empty or not) made ~30
 * palette-asserting UI tests red: the verdict depended on the invoking
 * shell's profile, not the code. The variable is stripped once per test
 * worker; tests that TEST NO_COLOR behavior set it themselves inside the
 * test body (and the shared afterEach hooks in those files delete it
 * again). The PTY helper sanitizes its child env separately — this file
 * covers the in-process tests only.
 */

delete process.env.NO_COLOR;

// REL-0150-D1 (the same isolation class): the host's TERM_PROGRAM must
// not flip the conservative frame mode under the byte-pinned grids —
// a suite run from Terminal.app would repaint every frame differently.
// Tests that TEST the mode set the variable inside the test body.
delete process.env.TERM_PROGRAM;

// Graphite (design.md §2, §3) — the colour inputs are the same class of
// leak. COLORTERM picks the tier (24-bit or 256), and KISO_THEME and
// COLORFGBG are rungs of the ground ladder; left to the host, the palette
// a test sees would depend on the terminal that ran the suite. The suite
// runs in the 24-bit tier with no ground set; tests that TEST a tier or a
// rung set the variable inside the test body.
process.env.COLORTERM = "truecolor";
delete process.env.KISO_THEME;
delete process.env.COLORFGBG;
// 0.47.1: without COLORTERM the tier also reads which terminal this is
// (graphite.ts terminalTier) — the host's own terminal must not decide it
for (const k of ["WT_SESSION", "ITERM_SESSION_ID", "WEZTERM_PANE", "KITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR", "TERMINAL_EMULATOR"]) delete process.env[k];

// DC-48 — INVARIANT ① THROWS UNDER TEST.
//
// In the field it cuts the row to width and says so once, because the
// alternative is losing a human's composer and their whole session to a
// row one column too wide (owner-lane ruling 2026-09-04, after DC-45 in
// a gate and DC-48 in the owner's hands). Every gate in this repository
// keeps the crash: a suite that quietly accepted a cut row would be the
// reversal's whole point thrown away.
process.env.KISO_INVARIANTS = "throw";
