/**
 * v2e — the approval-moment mini-diff through the CLI's topmost entry, on
 * a REAL PTY (24×80): an edit_file approval shows the ± diff below the
 * tool line (the human sees the change BEFORE deciding).
 *
 * Graphite §6 (R2a) — DECLARED REVERSAL of v2e's second half ("after the
 * approval the frozen summary stays ONE line — no diff residue"): the
 * settled card carries the edit's own diff, in every mode, so a call no
 * one was asked about shows what it changed too. And a BATCH edit's
 * approval shows its diff (it reached the panel with none).
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
	it("edit_file shows the ± diff at the approval, and the settled card shows it again (R2a)", () => {
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
				["needs you · asked by", "y\r"], // Graphite P4: the band's facts' dim run — one contiguous RAW span (the tool name's bold span sits BEFORE the reset code, so "<tool> needs approval" never matches the byte stream) — "y" + enter send the verdict
				["the tour is done", "exit\r"],
			],
			workdir,
		);
		const clean = stripANSI(out);
		// The approval-moment diff: - OLD / + NEW visible BEFORE the decision.
		expect(clean).toContain("- OLD");
		expect(clean).toContain("+ NEW");
		// The settled card: the ± stats on its head row.
		expect(clean).toContain("edit"); // W3 (sanctioned): the verb strips the _file suffix — both paths print the same verb
		expect(clean).toContain("+1 -1");
		// DECLARED REVERSAL (Graphite §6, R2a, owner 2026-09-29): v2e showed
		// the diff at the approval moment ONLY and froze the settled call to
		// one line, so a call no one approved (accept-edits, bypass) never
		// showed what it changed. The settled card now carries the edit's
		// own diff under its head — the diff rows come again AFTER the ± stat.
		const frozen = clean.indexOf("+1 -1");
		expect(frozen, "no settled head row").toBeGreaterThan(0);
		expect(clean.indexOf("- OLD", frozen), "the settled card shows no diff").toBeGreaterThan(frozen);
		expect(clean.indexOf("+ NEW", frozen), "the settled card shows no diff").toBeGreaterThan(frozen);
	}, 90_000);

	it("R2a: a batch edit's approval shows every hunk (red: it showed no diff at all)", () => {
		const { env } = isolatedEnv();
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
							input: { path: "work.txt", edits: [{ search: "line1", replace: "FIRST" }, { search: "line2", replace: "LAST" }], expectedRevision: "rev:68d57b25056a1d5a" },
						},
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "text_delta", text: "the batch is done" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["\u258c ", "go\r"],
				// the verdict waits on the panel's diff itself, the last hunk's row
				["+ LAST", "y\r"],
				["the batch is done", "exit\r"],
			],
			workdir,
		);
		const clean = stripANSI(out);
		const asked = clean.indexOf("needs you · asked by"); // Graphite P4: the band
		expect(asked, "the approval never opened").toBeGreaterThan(0);
		for (const row of ["- line1", "+ FIRST", "- line2", "+ LAST"]) expect(clean.indexOf(row, asked), `the approval shows no ${row}`).toBeGreaterThan(asked);
		expect(clean).toContain("+2 -2 \u00b7 2 hunks");
	}, 90_000);

	it("R2a: in bypass nothing asks, and the settled card still shows what the edit changed", () => {
		const { env } = isolatedEnv();
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
				{ events: [{ type: "text_delta", text: "the bypass edit is done" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const out = ptyRun({ ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" }, [["\u258c ", "go\r"], ["the bypass edit is done", "exit\r"]], workdir);
		const clean = stripANSI(out);
		expect(clean, "bypass asked").not.toContain("needs you · asked by");
		const head = clean.indexOf("+1 -1");
		expect(head, "no settled card").toBeGreaterThan(0);
		expect(clean.indexOf("- OLD", head), "the settled card shows no diff").toBeGreaterThan(head);
		expect(clean.indexOf("+ NEW", head), "the settled card shows no diff").toBeGreaterThan(head);
	}, 90_000);
});
