/**
 * v2d — the interleaving-impossibility gate through the CLI's topmost
 * entry, on a REAL PTY (24×80): a faux script fires THREE parallel tools
 * (one needs an approval), a long thinking block, and streaming text in
 * the same frame. After the ANSI strip, EVERY line must fully match a
 * known cell format — any concatenated (interleaved) line fails the lint.
 * The single-writer rule makes interleaving impossible by construction
 * (ADR-0040); this test pins it.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, stripANSI } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, env, feeds, timeout):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execvp("node", ["node", cli, "chat"])
    def winsize(rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    winsize(24, 80)
    full = b""
    fed = set()
    end = time.time() + timeout
    done = False
    while time.time() < end and not done:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                done = True
                break
            full += data
            for i, (needle, text) in enumerate(feeds):
                if i not in fed and needle.encode() in full:
                    os.write(fd, text.encode())
                    fed.add(i)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    sys.stdout.write(full.decode(errors="replace"))
    sys.exit(0)
`;

function ptyRun(env: NodeJS.ProcessEnv, feeds: [string, string][], timeout = 40): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-v2d-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${timeout})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
}

/** Every line a cell may render — the KNOWN format set. Any line that
 *  does not fully match one of these is an interleaved (concatenated)
 *  line, which the single-writer rule makes impossible. */
const CELL_LINE = [
	/^\[.*extensions?:.*\]$/, // the banner extensions row (v3 info row)
	/^⋯.*$/, // the ThinkingCell fold (W2: the ⋯ gutter — the midline mark is the state, never the text ellipsis)
	/^[▖▘▝▗] \S+ .*\d+s?$/, // the ToolCell running (W2: the spinner IS the gutter)
	/^⏸ \S+ .*$/, // the approval badge (W2: the ⏸ is the left gutter)
	/^◦ \S+ .*$/, // the ToolCell queued (W2: ◦ replaces → — · is the metadata separator)
	/^✓ \S+ .*\(\S.*, \d+\.\ds\)$/, // the ToolCell done (A4: the target rides the head row; A5: the · approved by <decider> tail)
	/^✗ \S+ .*\(\S.*, \d+\.\ds\)$/, // the ToolCell failed
	/^┌ answer truncated at max_tokens.*$/, // D4: the truncation notice row — the cut is named, never silent
	/^▞.*$/, // v3: the recap line ends the run
	/^│(?: .*)?$/, // v7 W7/W10: the bounded block's body rows — the settled tail + the W8 window's blank-padded rows (the "  │ " family, W2's gutter)
	/^└(?: .*)?$/, // v7 W7/W8/W10 + W21: the cut/waiting rows (the "  └ " family — "waiting for output", "+N earlier rows · ctrl+r", "capped by …") + the approval panel's bare └ corner
	/^aborted \(.*\)$/, // the aborted terminal label
	/^error: .*$/, // the error terminal label
	/^▸ .* · \/mode to switch.*$/, // v3 idle status line
	/^▸ run paused.*$/, // W21: the panel's paused status (the lead owns the input row — the affordance rides the status)
	/^\/ commands · ↑ history$/, // TUI v5 #16g: the dock's idle hint — the status row at enter (the status is still empty)
	/^[▖▘▝▗] working \d+s.*$/, // the running status line (all four spinner glyphs — the W21 hint "· esc to interrupt" rides the row)
	/^streaming text.*$/, // the TextCell body
	/^session \S+$/, // the session header
	/^\[faux mode.*$/, // the faux banner line
	/^(█|▀).*$/, /^\[?2m\]?█.*$/, // the logo rows (the dim code may ride the segment)
	/^the coding agent that survives kill -9$/, // the tagline
	/^v\d+\.\d+\.\d+.*$/, // the version + tagline row (W1 — the art is the wordmark, the text row does not repeat the name)
	/^│ ›.*│$/, // W6: the input row inside the box (the prompt › — the trim eats the pad)
	/^▌\s?.*$/, // the editor's SELF-RENDER row — the LINE-MODE brick (W6-kept byte-for-byte): the editor's first paint rides the CLI's pre-dock console.log message on the same row
	// TUI v5 #16f: the user block — the SGR-7 chip alone (the 2026-08-09
	// ruling retired the ▍ rail + the indent). Classified by its RAW byte
	// shape in the lint (the stripped form would be plain text).
	/^╭[─]+╮$/, /^╰[─]+╯$/, // W6: the box rails (the corners close the ─ run)
	/^─ .*$/, // W21: the approval panel's divider row (edge-to-edge, no gutter — the boxed ApprovalPrompt slot is gone, the panel superseded it)
	/^.*· faux · \[turn \d+ · faux\]$/, // the live status bar (session-prefixed)
	/^the tour is done$/, /^streaming text$/, // the TextCell bodies
];

/** Lint the RECONSTRUCTED lines — the raw split at every CSI (the v6
 *  steady-state frames carry NO CUP — the old CUP-only split would merge
 *  the whole steady transcript into one segment), then the pure CSI-
 *  parameter fragments (the move/clear sequences) are filtered and the
 *  line texts ANSI-stripped. A genuine interleave (two cells' content
 *  merged in one write) still lands inside one segment and fails the
 *  format set. */
const lint = (raw: string): string[] => {
	const bad: string[] = [];
	// the v6 write pattern: the MOVE/CLEAR sequences (A/B/G/D/K/J) precede
	// each line — the split at them (NOT at every CSI — a line's own SGRs
	// must stay with it) yields the true line segments
	const segments = raw.split(/\x1b\[[0-9;?]*[ABDGKJ]/);
	for (const seg of segments) {
		// a pure CSI-parameter fragment (e.g. "1A", "1G", "0K") — not a line
		if (/^[0-9;?]*[A-Za-z]$/.test(seg)) continue;
		// TUI v5 #16f: the user block's identity is the SGR-7 chip's own
		// bracket (the 2026-08-09 ruling retired the ▍ rail + the indent —
		// the stripped form would be indistinguishable from plain text, so
		// the RAW segment carries the classifier; the split never breaks
		// the chip: its CSIs are m-final, outside the ABDGKJ split class).
		if (/^\x1b\[7m .* \x1b\[27m/.test(seg)) continue;
		const t = seg
			.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
			.replace(/\[[0-9;]*m/g, "") // any residual SGR fragment (the split can strand a "[2m")
			.replace(/\r/g, "")
			.trim();
		if (t === "") continue;
		if (CELL_LINE.some((re) => re.test(t))) continue;
		bad.push(t);
	}
	return bad;
};

describe("TUI v2d (real PTY, 24×80)", () => {
	it("three parallel tools + an approval + long thinking + streaming text in ONE frame — every line matches a known cell format (no interleaving)", () => {
		const { env, dirs } = isolatedEnv();
		writeFileSync(
			join(dirs.extensions, "asky.mjs"),
			`export default {
	name: "asky",
	approvals: [{ decide: () => ({ action: "ask" }) }],
	tools: [{
		name: "asky_read",
		description: "a tool that needs approval",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: "asky ok", isError: false }),
	}],
};
`,
			"utf8",
		);
		const dir = mkdtempSync(join(tmpdir(), "kiso-v2d-"));
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						// Long thinking + streaming text + THREE tools in one
						// burst — every cell active in the same frame.
						{ type: "thinking", text: "T".repeat(120) },
						{ type: "text_delta", text: "streaming text" },
						{ type: "tool_call_end", callId: "c1", name: "list_dir", input: {} },
						// the shell runs LONG enough for the spinner row to paint
						// (a 0.0s echo coalesces away before any frame — the
						// running state never renders)
						{ type: "tool_call_end", callId: "c2", name: "shell", input: { command: "sleep 1; echo hi" } },
						{ type: "tool_call_end", callId: "c3", name: "asky_read", input: {} },
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "text_delta", text: "the tour is done" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["▌ ", "go\n"],
				// The asky extension asks for every tool — answer the two
				// panels that actually mount. list_dir NEVER panels: the
				// default tier's read-only allow beats the extension's ask
				// (W21's deny > allow > ask — an allow anywhere in the chain
				// outranks every ask), so it auto-approves and the run
				// launches all three calls immediately — the queue state
				// never paints. The needles ride the OPTIONS row's option-2
				// span — " 2 Yes, don't ask again for <tool>" is plain (no
				// SGR at sel 0), contiguous RAW, and unique per panel: the
				// rule line's tool name sits inside its own bold span, and
				// the no-queue run paints no bare-name row to race the
				// feeds. "y" + enter send the verdict.
				["2 Yes, don't ask again for shell", "y\n"],
				["2 Yes, don't ask again for asky_read", "y\n"],
				["the tour is done", "exit\n"],
			],
		);
		const clean = stripANSI(out);
		// The scenario actually ran: the three tools + the approvals + the
		// text. W21: list_dir auto-approves under the default tier (no
		// panel — the ⏸ badge row is gone, the panel superseded it) and
		// the run launches every call immediately (the ◦ queue rows never
		// paint); the shell and asky_read each mount a panel — the rule
		// line ("asked by …"), the settled cells carry the "approved"
		// decision tag, and the 1s shell's spinner row paints (the
		// spinner IS the gutter).
		expect(clean).toContain("shell needs approval"); // the shell panel's rule line
		expect(clean).toContain("asky_read needs approval"); // the asky panel's rule line
		expect(clean).toMatch(/[▖▘▝▗] shell \{"command":"sleep 1; echo hi"\} \d+s/); // the running shell — the spinner IS the gutter
		// A4: the target rides the settled head row (list_dir's input is {}
		// → the "(root)" fallback); A5: the decider is NAMED on the rows
		// that auto-approve (the extension's ask lost to the tier's allow).
		expect(clean).toMatch(/✓ list_dir \(root\) \(\d+ lines · approved by mode:default, \d+\.\ds\)/); // the auto-approved list_dir settled
		expect(clean).toMatch(/✓ shell sleep 1; echo hi \(exit 0, \d+\.\ds\)/); // the approved shell settled
		expect(clean).toMatch(/✓ asky_read  \(1 line, \d+\.\ds\)/); // W4: the result line count, not the input JSON
		expect(clean).toContain("approved by mode:default"); // A5: the decider tail rides the settled rows
		expect(clean).toContain("streaming text");
		expect(clean).toContain("the tour is done");
		// THE GATE: every line fully matches a known cell format. A
		// concatenated line (a tool line bleeding into the text, two tool
		// lines merged) FAILS the lint.
		const bad = lint(out);
		expect(bad).toEqual([]);
	}, 90_000);

	it("D4 — a max_tokens truncation is NAMED in the scrollback (the notice row, never silent)", () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-v2d-"));
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						// the partial answer, then the provider's own max_tokens
						// stop — the kernel's terminal is { kind: "max_tokens" }
						// (loop.ts: terminalForStop), the chat's terminal case
						// names the truncation.
						{ type: "text_delta", text: "streaming text" },
						{ type: "stop", reason: "max_tokens" },
					],
				},
			]),
			"utf8",
		);
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["▌ ", "go\n"],
				// the notice lands at the run's end — exit at idle
				["answer truncated", "exit\n"],
			],
		);
		const clean = stripANSI(out);
		// D4: the honest notice rides after the partial answer — the cut is
		// named in the scrollback, the model's text intact above it.
		expect(clean).toContain("streaming text");
		expect(clean).toContain('┌ answer truncated at max_tokens — say "continue" to finish');
		const bad = lint(out);
		expect(bad).toEqual([]);
	}, 90_000);
});
