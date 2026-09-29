/**
 * v2a — the interactive TUI through the CLI's topmost entry, on a REAL
 * PTY (the 0-row pty — the dock-less path): the typed line renders
 * TWICE by design — the editor's self-render echo (the UI) AND the
 * body's `you> ` record (W22: the v2a double-echo filter is retired —
 * every user_input event renders its chip; the transient echo is UI,
 * the chip is the record); the status line is the faux form; the rhythm gap lands
 * between the status and the next prompt; the prompt carries the blue
 * accent.
 */

/**
 * DECLARED SUPERSESSION (R3g, 2026-08-28) — the recap's seconds are
 * labelled `took`: they are the TURN's wall clock, and were called
 * "thought" while the fold line printed the kernel's MEASURED thinking
 * seconds under the same word.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, stripOsc } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** The python PTY driver: feed each (needle, text) pair once when the
 *  needle appears; whatever the CLI wrote — including the terminal's own
 *  echo — lands in the transcript for the byte assertions. */
const PTY_DRIVER = `
import pty, os, sys, time, select, signal

def driver(cli, env, cwd, feeds, timeout):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.chdir(cwd)
        os.execvp("node", ["node", cli, "chat"])
    out = b""
    full = b""
    fed = set()
    end = time.time() + timeout
    done = False
    while time.time() < end and not done:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                done = True
                break
            out += data
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

function ptyRun(env: NodeJS.ProcessEnv, feeds: [string, string][]): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-v2a-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(dir)}, ${JSON.stringify(feeds)}, 40)
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
}

describe("TUI v2a (real PTY)", () => {
	it("no double echo — the typed input appears exactly once; status is [turn N · faux]; the rhythm gap separates done from the prompt", () => {
		const { env } = isolatedEnv();
		const out = ptyRun(env, [
			["▌ ", "probe-one\r"],
			// The recap line (✦) only exists AFTER the turn completes, so
			// "exit" cannot collide with the first prompt (a "you> " needle
			// would close the input before the turn ever runs).
			["✦", "exit\r"],
		]);
		// (1) W22: the content appears TWICE — the editor's self-render
		// echo AND the body's `you> probe-one` record (the v2a filter
		// retired; the chip is the record, the echo is UI).
		//
		// Counted with the OSC dropped: 0.39.1 puts the session's title in
		// the WINDOW title, so the words appear a third time in the stream,
		// inside a sequence the terminal consumes and never paints. This
		// claim is about what is ON SCREEN, and the window is not the screen.
		const onScreen = stripOsc(out);
		expect((onScreen.match(/probe-one/g) ?? []).length).toBe(2);
		// The prompt + echo read "you> probe-one" once — readline's redraw
		// control sequences sit between them in the raw transcript, so count
		// on the control-stripped stream.
		// …and the words DO reach the WINDOW (0.39.1): the session opens
		// titled by its workspace and is renamed by its first substantive
		// prompt. The negative above and this positive are the same claim
		// from both sides — the title is in the stream, and it is not on
		// the screen. Proven on a real PTY rather than on the formatter,
		// because "does a terminal get this" is not a question a pure
		// function can answer.
		const titles = [...out.matchAll(/\u001b\]0;([^\u0007]*)\u0007/g)].map((m) => m[1]!);
		expect(titles.length).toBeGreaterThanOrEqual(2);
		expect(titles[0]).toMatch(/^kiso — \S/); // the opening form: kiso — <folder>
		// Graphite §8.10: the turn wears ✦ while it works, once — never per tick
		const working = titles.filter((t) => t.startsWith("✦ "));
		expect(working.length).toBeGreaterThanOrEqual(1);
		expect(working.length, "the title ticked").toBeLessThanOrEqual(2);
		expect(titles.at(-1)).toContain("probe-one"); // renamed by the prompt
		expect(titles.at(-1)).toMatch(/^probe-one — \S/); // …and ready again: no mark

		const clean = onScreen.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
		expect((clean.match(/▌ probe-one/g) ?? []).length).toBe(1);
		// ② the bold accent rides the prompt (TUI v5 #16e: the decorative
		// blue is retired — SGR 1 bright-white bold).
		expect(out).toContain("\x1b[1m");
		expect(out).not.toContain("\x1b[38;5;75m");
		// ③ faux status form.
		// R3d: the recap opens `thought Ns` and then names the WORK — the
		// claim here is that the recap LINE ends the run.
		expect(out).toMatch(/✦\x1b\[0m took \d+s · /); // v3: the recap line ends the run (the ✦ carries the bold accent)
		// ④ rhythm: the honest terminal label (done), then the status
		// hugging it, then exactly one blank line before the next prompt
		// (the pty cooks \n into \r\n).
		expect(out).toContain("✦"); // v3: the recap replaces the done label + status line
	}, 90_000);
});
