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
	/^you> .*$/, // the UserCell
	/^….*$/, // the ThinkingCell fold
	/^→ \S+ .*[⏸◐◓◑◒]?.*\d*s?$/, // the ToolCell pending/running
	/^→ \S+ .*⏸$/, // the approval badge
	/^→ \S+ .*$/, // the ToolCell pending (no badge)
	/^✓ \S+ \(.*, \d+\.\ds\)$/, // the ToolCell done
	/^✗ \S+ \(.*, \d+\.\ds\)$/, // the ToolCell failed
	/^done$/, // the terminal label
	/^aborted \(.*\)$/, // the aborted terminal label
	/^error: .*$/, // the error terminal label
	/^\[turn \d+ · faux\]$/, // the status line
	/^streaming text.*$/, // the TextCell body
	/^session \S+$/, // the session header
	/^\[faux mode.*$/, // the faux banner line
	/^(█|▀).*$/, /^\[?2m\]?█.*$/, // the logo rows (the dim code may ride the segment)
	/^the coding agent that survives kill -9$/, // the tagline
	/^v\d+\.\d+\.\d+.*$/, // the version row
	/^▌you>.*$/, // the input row
	/^╌+$/, // the separator
	/^ {0,2}(approved|denied.*)$/, // the permission_decided raw
	/^approve .*\(y\/n\)$/, // the dock's takeover question
	/^.*· faux · \[turn \d+ · faux\]$/, // the live status bar (session-prefixed)
	/^the tour is done$/, /^streaming text$/, // the TextCell bodies
];

/** Lint the RECONSTRUCTED lines — the raw split at the cursor-positioning
 *  sequences, then ANSI-stripped per line. A naive strip of the whole
 *  transcript flattens ADJACENT rows into one string (false positives);
 *  the true cell lines are the segments between the \x1b[<row>;1H writes —
 *  and a genuine interleave (two cells' content merged in one write) still
 *  lands inside one segment and fails the format set. */
const lint = (raw: string): string[] => {
	const bad: string[] = [];
	const segments = raw.split(/\x1b\[[0-9;]*H/);
	for (const seg of segments) {
		const t = seg.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "").trim();
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
						{ type: "tool_call_end", callId: "c2", name: "shell", input: { command: "echo hi" } },
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
				["you> ", "go\n"],
				// The asky extension asks for EVERY tool — answer each question
				// in order (list_dir, shell, then asky_read).
				["approve list_dir", "y\n"],
				["approve shell", "y\n"],
				["approve asky_read", "y\n"],
				["the tour is done", "exit\n"],
			],
		);
		const clean = stripANSI(out);
		// The scenario actually ran: the three tools + the approval + the text.
		expect(clean).toContain("→ list_dir {}");
		expect(clean).toContain("→ shell {\"command\":\"echo hi\"}");
		expect(clean).toContain("→ list_dir {} ⏸"); // the approval badge (the first, stable)
		expect(clean).toMatch(/✓ asky_read \(\{}, \d+\.\ds\)/);
		expect(clean).toContain("streaming text");
		expect(clean).toContain("the tour is done");
		// THE GATE: every line fully matches a known cell format. A
		// concatenated line (a tool line bleeding into the text, two tool
		// lines merged) FAILS the lint.
		const bad = lint(out);
		expect(bad).toEqual([]);
	}, 90_000);
});
