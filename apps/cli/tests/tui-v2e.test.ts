/**
 * v2e — the approval-moment mini-diff through the CLI's topmost entry, on
 * a REAL PTY (24×80): an edit_file approval shows the ± diff below the
 * tool line (the human sees the change BEFORE deciding); after the
 * approval the frozen summary stays ONE line — no diff residue (v2d's
 * anti-leak principle).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, stripANSI } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, env, feeds, workdir, timeout):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.chdir(workdir)
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

function ptyRun(env: NodeJS.ProcessEnv, feeds: [string, string][], workdir: string, timeout = 40): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-v2e-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${JSON.stringify(workdir)}, ${timeout})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
}

describe("TUI v2e (real PTY, 24×80) — the approval-moment diff", () => {
	it("edit_file shows the ± diff at the approval, the frozen summary stays ONE line", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-v2e-"));
		const workdir = join(dir, "work");
		mkdirSync(workdir, { recursive: true });
		writeFileSync(join(workdir, "work.txt"), "line1\nOLD\nline2\n", "utf8");
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						{
							type: "tool_call_end",
							callId: "c1",
							name: "edit_file",
							input: { path: "work.txt", search: "OLD", replace: "NEW", expectedRevision: "rev:68d57b25056a1d5a" },
						},
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
				["▌ ", "go\r"],
				["needs approval", "y\r"], // the rule line's dim run — one contiguous RAW span (the tool name's bold span sits BEFORE the reset code, so "<tool> needs approval" never matches the byte stream) — "y" + enter send the verdict
				["the tour is done", "exit\r"],
			],
			workdir,
		);
		const clean = stripANSI(out);
		// The approval-moment diff: - OLD / + NEW visible BEFORE the decision.
		expect(clean).toContain("- OLD");
		expect(clean).toContain("+ NEW");
		// The frozen summary: ONE line with the ± stats.
		expect(clean).toContain("edit"); // W3 (sanctioned): the verb strips the _file suffix — both paths print the same verb
		expect(clean).toContain("+1 -1");
		// NO diff residue after the freeze — the last diff row precedes the
		// frozen summary, and the summary line itself is a single line.
		//
		// R2 (law 1.3): the settled row's gutter is two spaces now (the ✓
		// is retired), so `  edit` no longer names the frozen row alone —
		// it also matches the approval panel's own title row, which comes
		// BEFORE the diff and made this comparison read backwards. The
		// anchor is the ± stat, which only the frozen summary carries.
		const lastMinus = clean.lastIndexOf("- OLD");
		const frozen = clean.indexOf("+1 -1");
		expect(frozen, "no frozen summary row").toBeGreaterThan(0);
		expect(lastMinus).toBeLessThan(frozen);
	}, 90_000);
});
